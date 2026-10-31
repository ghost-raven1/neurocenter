import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';

import { isDeepStrictEqual } from 'node:util';
import { LEGACY_DEMO_SKILLS } from '../../../shared/legacy-demo-retirement.cjs';
import type { ISkillsStorage } from '../storage/skills-storage.interface';

import {
    archiveImportedSkill,
    importedSkillSnapshot,
    importedSkillPayloadHash,
    skillCreateFromFile,
} from './asset-import';

import { ILegacySkillExpected } from './interfaces';

/**
 * Находит скилл в списке разрешённых для миграции.
 *
 * Мы не должны архивировать произвольные скиллы:
 * операция разрешена только для заранее проверенных записей.
 */
function getMigrationPolicy(id: string) {
    const policy = LEGACY_DEMO_SKILLS.find((item) => item.id === id);

    if (!policy) {
        throw new BadRequestException('Скилл не входит в проверенную миграцию.');
    }

    return policy;
}

const isSame = isDeepStrictEqual;

/**
 * Проверяет состояние legacy-скилла перед миграцией.
 *
 * Возвращает:
 * - снимок текущего скилла;
 * - его исходную область и проект;
 * - архивные данные;
 * - оригинальные исходные байты;
 * - список версий, исходные байты которых отсутствуют.
 *
 * Важно:
 * Проверка ничего не исправляет и не восстанавливает.
 * Она только собирает информацию о текущем состоянии.
 */
export async function inspectLegacySkill(storage: ISkillsStorage, id: string) {
    // Разрешаем проверку только скиллов из миграционного списка.
    getMigrationPolicy(id);

    // Для проверки целостности необходим доступ к исходным байтам.
    if (!storage.sourceReceipt) {
        throw new ServiceUnavailableException('Хранилище не поддерживает проверку исходных байтов.');
    }

    const file = await storage.readSkill(id);

    // Получаем оригинальные байты текущей версии.
    const source = await storage.sourceReceipt(id);

    const missingVersions: number[] = [];

    // Защита от чрезмерно большой истории.
    if (file.meta.history.length > 1000) {
        throw new ConflictException('Историю нужно проверить отдельно.');
    }

    // Проверяем наличие исходных байтов каждой уникальной версии.
    const versions = [...new Set(file.meta.history.map((item) => item.version))];

    for (const version of versions) {
        try {
            await storage.sourceReceipt(id, version);
        } catch (error) {
            // Отсутствующая версия фиксируется отдельно.
            // Любая другая ошибка должна прерывать проверку.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                missingVersions.push(version);
            } else {
                throw error;
            }
        }
    }

    // Возвращаем снимок вместе с дополнительными метаданными.
    return {
        ...importedSkillSnapshot(file),

        name: file.meta.name,
        scope: file.meta.scope,
        projectId: file.meta.projectId,

        archivedAt: file.meta.archivedAt,
        archive: file.meta.assetArchive,

        source,
        missingVersions,
    };
}

/**
 * Архивирует legacy-скилл.
 *
 * Основные гарантии:
 * 1. Архивировать можно только заранее проверенный скилл.
 * 2. Данные не должны измениться после предварительной проверки.
 * 3. Исходная область скилла должна остаться прежней.
 * 4. Оригинальные байты должны сохраниться.
 * 5. Повторный запрос с тем же requestKey безопасно обрабатывается
 *    как восстановление результата предыдущей операции.
 *
 * Зависимости проекта не восстанавливаются.
 */
export async function retireLegacySkill(
    storage: ISkillsStorage,
    id: string,
    expected: ILegacySkillExpected,
    actor: string,
    requestKey: string,
) {
    const policy = getMigrationPolicy(id);

    // Проверяем ключ идемпотентности и ожидаемый снимок.
    // requestKey должен быть UUID.
    const isValidRequestKey = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestKey);

    const isValidExpected =
        expected?.id === id &&
        Number.isSafeInteger(expected.version) &&
        typeof expected.hash === 'string' &&
        /^[a-f0-9]{64}$/.test(expected.hash);

    if (!isValidRequestKey || !isValidExpected) {
        throw new BadRequestException('Нужны точная проверка миграции и ключ запроса.');
    }

    // Без доступа к оригинальным байтам нельзя гарантировать
    // сохранность исходной версии.
    if (!storage.sourceReceipt) {
        throw new ServiceUnavailableException('Хранилище не поддерживает проверку исходных байтов.');
    }

    const current = await storage.readSkill(id);

    // Определяем, выполнялась ли уже эта операция.
    // Это позволяет повторно отправить запрос после сбоя
    // и проверить результат предыдущей попытки.
    const isRecovery = current.meta.assetArchive?.requestKey === requestKey;

    if (isRecovery) {
        // --------------------------------------------------
        // СЦЕНАРИЙ 1. Повторный запрос после архивирования
        // --------------------------------------------------

        // Проверяем, что архивированная запись не изменилась
        // после первоначальной операции.
        const archive = current.meta.assetArchive!;

        const hasValidArchive =
            !!current.meta.archivedAt &&
            archive.previousHash === expected.hash &&
            current.meta.version === expected.version + 1 &&
            archive.payloadHash === importedSkillPayloadHash(skillCreateFromFile(current));

        if (!hasValidArchive) {
            throw new ConflictException('Архивированная запись изменена после миграции.');
        }
    } else {
        // --------------------------------------------------
        // СЦЕНАРИЙ 2. Первичное архивирование
        // --------------------------------------------------

        // Проверяем, что с момента предварительной проверки
        // исходная запись не менялась.
        const hasChanged =
            current.meta.archivedAt ||
            current.meta.version !== expected.version ||
            importedSkillSnapshot(current).hash !== expected.hash ||
            !isSame(await storage.sourceReceipt(id), expected.source);

        if (hasChanged) {
            throw new ConflictException('Исходные байты или карточка изменились после проверки.');
        }

        if (policy.projectId) {
            // ----------------------------------------------
            // Ветка A. Скилл принадлежит удалённому проекту
            // ----------------------------------------------

            // Нельзя архивировать запись, если её область
            // или идентификатор проекта изменились.
            if (current.meta.scope !== 'project' || current.meta.projectId !== policy.projectId) {
                throw new ConflictException('Исходная область скилла изменилась.');
            }

            const now = new Date().toISOString();
            const nextVersion = current.meta.version + 1;

            // Переводим запись в архивное состояние.
            // История дополняется новой версией.
            await storage.writeSkill(
                id,
                {
                    ...current.meta,

                    version: nextVersion,
                    archivedAt: now,
                    updatedAt: now,

                    history: [
                        ...current.meta.history,
                        {
                            version: nextVersion,
                            at: now,
                            author: actor,
                            note: 'Карантин исходной записи удалённого проекта; ' + 'зависимости не восстановлены',
                        },
                    ],

                    assetArchive: {
                        requestKey,
                        previousHash: expected.hash,

                        payloadHash: importedSkillPayloadHash(skillCreateFromFile(current)),

                        version: nextVersion,
                        restore: false,
                    },
                },

                // Тело и ресурсы сохраняются без изменений.
                current.body,
                current.resources,

                {
                    actor,
                    source: 'editor',
                },

                // Передаём исходную запись для контроля записи.
                current,
            );
        } else {
            // ----------------------------------------------
            // Ветка B. Обычный импортированный скилл
            // ----------------------------------------------

            // Используем существующий механизм архивирования.
            // Восстановление при этом отключено.
            await archiveImportedSkill(storage, id, expected, actor, false, requestKey);
        }
    }

    // ------------------------------------------------------
    // ФИНАЛЬНАЯ ПРОВЕРКА СОХРАННОСТИ ИСХОДНЫХ БАЙТОВ
    // ------------------------------------------------------

    // Повторно читаем оригинальные байты именно той версии,
    // которая была проверена до начала миграции.
    const preservedSource = await storage.sourceReceipt(id, expected.version);

    // Если байты не совпадают, сообщаем о проблеме.
    // Архив при этом уже мог быть успешно создан.
    if (!isSame(preservedSource, expected.source)) {
        throw new ServiceUnavailableException(
            'Архив сохранён, но исходные байты ещё не подтверждены. Повторите тот же запрос.',
        );
    }

    // Возвращаем итоговое состояние и подтверждённые байты.
    return {
        ...(await inspectLegacySkill(storage, id)),

        preservedSource,
    };
}
