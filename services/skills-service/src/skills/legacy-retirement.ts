import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { LEGACY_DEMO_SKILLS } from '../../../shared/legacy-demo-retirement.cjs';
import type { ISkillsStorage, ISkillSourceReceipt } from '../storage/skills-storage.interface';
import {
    archiveImportedSkill,
    importedSkillSnapshot,
    importedSkillPayloadHash,
    skillCreateFromFile,
    type ISkillImportExpected,
} from './asset-import';

export interface ILegacySkillExpected extends ISkillImportExpected {
    source: ISkillSourceReceipt;
}
function policy(id: string) {
    const found = LEGACY_DEMO_SKILLS.find((p) => p.id === id);
    if (!found) throw new BadRequestException('Скилл не входит в проверенную миграцию.');
    return found;
}
const same = isDeepStrictEqual;

/** Retirement preserves original scope, full bytes and every available version. It never repairs or invents dependencies. */
export async function inspectLegacySkill(storage: ISkillsStorage, id: string) {
    policy(id);
    if (!storage.sourceReceipt)
        throw new ServiceUnavailableException('Хранилище не поддерживает проверку исходных байтов.');
    const file = await storage.readSkill(id),
        source = await storage.sourceReceipt(id),
        missingVersions: number[] = [];
    if (file.meta.history.length > 1000) throw new ConflictException('Историю нужно проверить отдельно.');
    for (const version of [...new Set(file.meta.history.map((h) => h.version))]) {
        try {
            await storage.sourceReceipt(id, version);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') missingVersions.push(version);
            else throw error;
        }
    }
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

export async function retireLegacySkill(
    storage: ISkillsStorage,
    id: string,
    expected: ILegacySkillExpected,
    actor: string,
    requestKey: string,
) {
    const entry = policy(id);
    if (
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestKey) ||
        expected?.id !== id ||
        !Number.isSafeInteger(expected.version) ||
        typeof expected.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(expected.hash)
    )
        throw new BadRequestException('Нужны точная проверка миграции и ключ запроса.');
    if (!storage.sourceReceipt)
        throw new ServiceUnavailableException('Хранилище не поддерживает проверку исходных байтов.');
    const current = await storage.readSkill(id),
        recovered = current.meta.assetArchive?.requestKey === requestKey;
    if (recovered) {
        if (
            !current.meta.archivedAt ||
            current.meta.assetArchive!.previousHash !== expected.hash ||
            current.meta.version !== expected.version + 1 ||
            current.meta.assetArchive!.payloadHash !== importedSkillPayloadHash(skillCreateFromFile(current))
        )
            throw new ConflictException('Архивированная запись изменена после миграции.');
    } else {
        if (
            current.meta.archivedAt ||
            current.meta.version !== expected.version ||
            importedSkillSnapshot(current).hash !== expected.hash ||
            !same(await storage.sourceReceipt(id), expected.source)
        )
            throw new ConflictException('Исходные байты или карточка изменились после проверки.');
        if (entry.projectId) {
            if (current.meta.scope !== 'project' || current.meta.projectId !== entry.projectId)
                throw new ConflictException('Исходная область скилла изменилась.');
            const now = new Date().toISOString(),
                version = current.meta.version + 1;
            await storage.writeSkill(
                id,
                {
                    ...current.meta,
                    version,
                    archivedAt: now,
                    updatedAt: now,
                    history: [
                        ...current.meta.history,
                        {
                            version,
                            at: now,
                            author: actor,
                            note: 'Карантин исходной записи удалённого проекта; зависимости не восстановлены',
                        },
                    ],
                    assetArchive: {
                        requestKey,
                        previousHash: expected.hash,
                        payloadHash: importedSkillPayloadHash(skillCreateFromFile(current)),
                        version,
                        restore: false,
                    },
                },
                current.body,
                current.resources,
                { actor, source: 'editor' },
                current,
            );
        } else await archiveImportedSkill(storage, id, expected, actor, false, requestKey);
    }
    const preserved = await storage.sourceReceipt(id, expected.version);
    if (!same(preserved, expected.source))
        throw new ServiceUnavailableException(
            'Архив сохранён, но исходные байты ещё не подтверждены. Повторите тот же запрос.',
        );
    return { ...(await inspectLegacySkill(storage, id)), preservedSource: preserved };
}
