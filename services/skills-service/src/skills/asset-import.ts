import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ISkillsStorage } from '../storage/skills-storage.interface';
import type { ISkillCreateRequest, ISkillFile, ISkillMeta } from './skills.model';
import { skillPath, validateSkillCreate, skillPublicationMeta } from './skill-validation';
import { validateResources } from './skill-resources';
import { ISkillImportExpected } from './interfaces';

function fingerprint(value: unknown): string {
    const sortObject = (input: unknown): unknown => {
        if (Array.isArray(input)) {
            return input.map(sortObject);
        }

        if (input === null || typeof input !== 'object') {
            return input;
        }

        const entries = Object.entries(input)
            .filter(([, value]) => value !== undefined)
            .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
            .map(([key, value]) => [key, sortObject(value)]);

        return Object.fromEntries(entries);
    };

    const normalized = sortObject(value);
    const serialized = JSON.stringify(normalized);

    return createHash('sha256').update(serialized).digest('hex');
}

export function importedSkillInput(raw: unknown): ISkillCreateRequest {
    const input = validateSkillCreate(raw as ISkillCreateRequest);
    if (input.path !== 'common') {
        throw new BadRequestException('Импорт ассетов добавляет скиллы только в общий каталог.');
    }
    return input;
}

export function importedSkillSnapshot(file: ISkillFile) {
    return {
        kind: 'skill' as const,
        id: file.path,
        version: file.meta.version,
        hash: fingerprint({
            generation: file.meta.generation,
            version: file.meta.version,
            archivedAt: file.meta.archivedAt,
            input: skillCreateFromFile(file),
        }),
    };
}

export function skillCreateFromFile(file: ISkillFile): ISkillCreateRequest {
    return {
        path: skillPath(file.path.slice(0, file.path.lastIndexOf('/'))),
        slug: file.meta.slug,
        name: file.meta.name.trim().normalize('NFC'),
        body: file.body,
        meta: skillPublicationMeta(file.meta),
        resources: validateResources(file.resources),
    };
}

export const importedSkillPayloadHash = (value: ISkillCreateRequest): string => fingerprint(value);

/**
 * Публикует импортированный скилл в общий каталог.
 *
 * Проверка payload и CAS не зависят от каталожной БД.
 * Для фиксации результата используется существующий durable FS-журнал.
 *
 * Если скилл уже существует:
 * - обновляем его только при наличии expected;
 * - проверяем, что с момента предварительного просмотра он не изменился.
 *
 * Если скилл отсутствует:
 * - создаём новый.
 *
 * Повторный запрос с тем же requestKey не создаёт новую версию.
 */
export async function publishImportedSkill(
    storage: ISkillsStorage,
    raw: unknown,
    requestKey: string,
    actor: string,
    expected?: ISkillImportExpected,
): Promise<ISkillFile> {
    // Проверяем входные данные и приводим их к ожидаемой структуре.
    const input = importedSkillInput(raw);

    // Формируем путь в общем каталоге.
    const path = `common/${input.slug}`;

    // Вычисляем хеш входных данных.
    // Он позволяет определить, соответствует ли содержимое опубликованного
    // скилла исходному payload.
    const payloadHash = fingerprint(input);

    // Проверяем формат ключа идемпотентности (UUID v4).
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestKey)) {
        throw new BadRequestException('Некорректный ключ импорта скилла.');
    }

    // Получаем текущее состояние скилла, если он уже существует.
    const current = (await storage.existsSkill(path)) ? await storage.readSkill(path) : undefined;

    // Проверяем, не был ли этот импорт уже выполнен.
    // Это необходимо для ситуации, когда запись прошла успешно,
    // но клиент не получил подтверждение (ACK).
    if (current?.meta.assetImport?.requestKey === requestKey) {
        const previousImport = current.meta.assetImport;

        // Проверяем, что результат предыдущего импорта не изменился:
        // - payload соответствует исходному запросу;
        // - версия совпадает с сохранённой;
        // - текущее содержимое соответствует исходному payload;
        // - скилл не находится в архиве.
        if (
            previousImport.payloadHash !== payloadHash ||
            previousImport.version !== current.meta.version ||
            fingerprint(skillCreateFromFile(current)) !== payloadHash ||
            current.meta.archivedAt
        ) {
            throw new ConflictException('Опубликованный скилл изменился после сохранённого импорта.');
        }

        // Импорт уже выполнен, повторно ничего не записываем.
        return current;
    }

    // Если передан expected, значит пользователь предварительно
    // просмотрел изменения и подтверждает обновление существующего скилла.
    if (expected) {
        // Проверяем, что скилл существует и не изменился
        // после предварительного просмотра:
        // - идентификатор совпадает;
        // - хеш снимка совпадает;
        // - версия не изменилась.
        if (
            !current ||
            expected.id !== path ||
            importedSkillSnapshot(current).hash !== expected.hash ||
            current.meta.version !== expected.version
        ) {
            throw new ConflictException('Скилл изменился после предварительного просмотра.');
        }

        // Запрещаем обновление архивированного скилла.
        // Сначала его необходимо восстановить.
        if (current.meta.archivedAt) {
            throw new ConflictException('Скилл находится в архиве. Сначала верните его в общий каталог.');
        }

        // Если содержимое уже совпадает с новым payload,
        // повторная запись и увеличение версии не нужны.
        if (fingerprint(skillCreateFromFile(current)) === payloadHash) {
            return current;
        }
    } else if (current) {
        // Если предварительного просмотра не было,
        // запрещаем перезаписывать существующий скилл.
        throw new ConflictException('Скилл уже существует. Обновите предварительный просмотр.');
    }

    // Подготавливаем новую версию и время публикации.
    const now = new Date().toISOString();
    const version = (current?.meta.version ?? 0) + 1;

    // Формируем метаданные публикуемого скилла.
    const meta: ISkillMeta = {
        ...input.meta,

        // Основные данные скилла.
        name: input.name,
        slug: input.slug,
        scope: 'common',

        // Сохраняем поколение и владельца существующего скилла.
        // Для нового скилла создаём поколение и назначаем владельца.
        generation: current?.meta.generation ?? randomUUID(),
        owner: current?.meta.owner ?? actor,

        // Заполняем необязательные коллекции пустыми массивами.
        mcp: input.meta?.mcp ?? [],
        plugins: input.meta?.plugins ?? [],
        tags: input.meta?.tags ?? [],

        // Информация о версии и времени обновления.
        version,
        updatedAt: now,

        // Сохраняем историю предыдущих версий
        // и добавляем запись о текущем импорте.
        history: [
            ...(current?.meta.history ?? []),
            {
                version,
                at: now,
                author: actor,
                note: 'Импорт ассета',
            },
        ],

        // Сохраняем информацию об импорте.
        // Она используется для распознавания повторного запроса.
        assetImport: {
            requestKey,
            payloadHash,
            version,
        },
    };

    // Если скилл уже существует, обновляем его.
    // Передаём current для проверки актуальности состояния (CAS).
    if (current) {
        await storage.writeSkill(
            path,
            meta,
            input.body,
            input.resources,
            {
                actor,
                source: 'editor',
            },
            current,
        );
    } else {
        // Если скилла ещё нет, пытаемся создать его.
        // Если другой запрос успел создать скилл раньше,
        // createSkill возвращает false.
        if (
            !(await storage.createSkill(path, meta, input.body, input.resources, {
                actor,
                source: 'editor',
            }))
        ) {
            throw new ConflictException('Скилл создан другим запросом во время импорта.');
        }
    }

    // Возвращаем фактически сохранённое состояние скилла.
    return storage.readSkill(path);
}

/**
 * Архивирование меняет только видимость текущей общей карточки.
 * Старые версии и связанные ресурсы остаются доступными.
 *
 * При restore = true скилл восстанавливается из архива.
 */
export async function archiveImportedSkill(
    storage: ISkillsStorage,
    id: string,
    expected: ISkillImportExpected,
    actor: string,
    restore = false,
    requestKey?: string,
): Promise<ISkillFile> {
    // Формируем путь к скиллу.
    const path = skillPath(id);

    // Разрешаем архивировать только скиллы общего каталога.
    if (!/^common\/[^/]+$/.test(path)) {
        throw new BadRequestException('Выберите скилл общего каталога.');
    }

    // Проверяем, что скилл существует.
    if (!(await storage.existsSkill(path))) {
        throw new NotFoundException('Скилл отсутствует в каталоге.');
    }

    // Читаем актуальное состояние скилла.
    const current = await storage.readSkill(path);

    // Проверяем, не обрабатывался ли уже этот запрос.
    // Это обеспечивает идемпотентность при повторной отправке запроса.
    if (requestKey && current.meta.assetArchive?.requestKey === requestKey) {
        const archive = current.meta.assetArchive;

        // Проверяем, что повторный запрос соответствует ранее выполненной операции:
        // - исходная версия скилла совпадает;
        // - содержимое скилла не изменилось;
        // - версия совпадает с сохранённой;
        // - операция (архивирование или восстановление) та же;
        // - текущее состояние архива соответствует операции.
        if (
            archive.previousHash !== expected.hash ||
            archive.payloadHash !== fingerprint(skillCreateFromFile(current)) ||
            archive.version !== current.meta.version ||
            archive.restore !== restore ||
            !!current.meta.archivedAt === restore
        ) {
            throw new ConflictException('Скилл изменился после сохранённого архивирования.');
        }

        // Запрос уже был успешно выполнен.
        // Возвращаем текущее состояние без повторной записи.
        return current;
    }

    // Проверяем, что скилл не изменился после предварительной проверки:
    // - идентификатор соответствует пути;
    // - контрольная сумма совпадает;
    // - версия не изменилась.
    if (
        expected.id !== path ||
        importedSkillSnapshot(current).hash !== expected.hash ||
        current.meta.version !== expected.version
    ) {
        throw new ConflictException('Скилл изменился после проверки последствий.');
    }

    // Если скилл уже находится в требуемом состоянии,
    // ничего не меняем.
    if (!!current.meta.archivedAt === !restore) {
        return current;
    }

    // Перед восстановлением дополнительно проверяем содержимое скилла.
    if (restore) {
        validateSkillCreate(skillCreateFromFile(current));
    }

    // Подготавливаем новую версию и время изменения.
    const now = new Date().toISOString();
    const version = current.meta.version + 1;

    // Формируем обновлённые метаданные:
    // - увеличиваем версию;
    // - обновляем дату изменения;
    // - добавляем запись в историю операций.
    const meta: ISkillMeta = {
        ...current.meta,
        version,
        updatedAt: now,
        history: [
            ...current.meta.history,
            {
                version,
                at: now,
                author: actor,
                note: restore ? 'Возвращён из архива' : 'Убран из общего каталога',
            },
        ],
    };

    // Сохраняем ключ операции и контрольные суммы.
    // Они понадобятся для распознавания повторного запроса.
    if (requestKey) {
        meta.assetArchive = {
            requestKey,
            previousHash: expected.hash,
            payloadHash: fingerprint(skillCreateFromFile(current)),
            version,
            restore,
        };
    }

    // Меняем состояние архива:
    // - restore = true: удаляем archivedAt;
    // - restore = false: устанавливаем archivedAt.
    if (restore) {
        delete meta.archivedAt;
    } else {
        meta.archivedAt = now;
    }

    // Сохраняем изменения, не изменяя тело и ресурсы скилла.
    await storage.writeSkill(
        path,
        meta,
        current.body,
        current.resources,
        {
            actor,
            source: 'editor',
        },
        current,
    );

    // Возвращаем сохранённую версию скилла.
    return storage.readSkill(path);
}
