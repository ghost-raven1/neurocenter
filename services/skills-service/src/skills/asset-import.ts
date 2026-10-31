import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ISkillsStorage } from '../storage/skills-storage.interface';
import type { ISkillCreateRequest, ISkillFile, ISkillMeta } from './skills.model';
import { skillPath, validateSkillCreate, skillPublicationMeta } from './skill-validation';
import { validateResources } from './skill-resources';

function fingerprint(value: unknown): string {
    const sorted = (input: unknown): unknown =>
        Array.isArray(input)
            ? input.map(sorted)
            : input && typeof input === 'object'
              ? Object.fromEntries(
                    Object.entries(input)
                        .filter(([, item]) => item !== undefined)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([key, item]) => [key, sorted(item)]),
                )
              : input;
    return createHash('sha256')
        .update(JSON.stringify(sorted(value)))
        .digest('hex');
}

export interface ISkillImportExpected {
    id: string;
    version: number;
    hash: string;
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

/** Проверка payload и CAS не зависит от каталожной БД; записывает существующий durable FS-журнал. */
export async function publishImportedSkill(
    storage: ISkillsStorage,
    raw: unknown,
    requestKey: string,
    actor: string,
    expected?: ISkillImportExpected,
): Promise<ISkillFile> {
    const input = importedSkillInput(raw),
        path = 'common/' + input.slug,
        payloadHash = fingerprint(input);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestKey)) {
        throw new BadRequestException('Некорректный ключ импорта скилла.');
    }
    const current = (await storage.existsSkill(path)) ? await storage.readSkill(path) : undefined;
    // После потерянного ACK тот же write не создаёт следующую версию и не присваивает чужую правку.
    if (current?.meta.assetImport?.requestKey === requestKey) {
        if (
            current.meta.assetImport.payloadHash !== payloadHash ||
            current.meta.assetImport.version !== current.meta.version ||
            fingerprint(skillCreateFromFile(current)) !== payloadHash ||
            current.meta.archivedAt
        ) {
            throw new ConflictException('Опубликованный скилл изменился после сохранённого импорта.');
        }
        return current;
    }
    if (expected) {
        if (
            !current ||
            expected.id !== path ||
            importedSkillSnapshot(current).hash !== expected.hash ||
            current.meta.version !== expected.version
        ) {
            throw new ConflictException('Скилл изменился после предварительного просмотра.');
        }
        if (current.meta.archivedAt) {
            throw new ConflictException('Скилл находится в архиве. Сначала верните его в общий каталог.');
        }
        if (fingerprint(skillCreateFromFile(current)) === payloadHash) {
            return current;
        }
    } else if (current) {
        throw new ConflictException('Скилл уже существует. Обновите предварительный просмотр.');
    }
    const now = new Date().toISOString(),
        version = (current?.meta.version ?? 0) + 1;
    const meta: ISkillMeta = {
        ...input.meta,
        name: input.name,
        slug: input.slug,
        scope: 'common',
        generation: current?.meta.generation ?? randomUUID(),
        mcp: input.meta?.mcp ?? [],
        plugins: input.meta?.plugins ?? [],
        tags: input.meta?.tags ?? [],
        owner: current?.meta.owner ?? actor,
        version,
        updatedAt: now,
        history: [...(current?.meta.history ?? []), { version, at: now, author: actor, note: 'Импорт ассета' }],
        assetImport: { requestKey, payloadHash, version },
    };
    if (current) {
        await storage.writeSkill(path, meta, input.body, input.resources, { actor, source: 'editor' }, current);
    } else if (!(await storage.createSkill(path, meta, input.body, input.resources, { actor, source: 'editor' }))) {
        throw new ConflictException('Скилл создан другим запросом во время импорта.');
    }
    return storage.readSkill(path);
}

/** Архив меняет только видимость текущей общей карточки; старые версии и ресурсы остаются доступны. */
export async function archiveImportedSkill(
    storage: ISkillsStorage,
    id: string,
    expected: ISkillImportExpected,
    actor: string,
    restore = false,
    requestKey?: string,
): Promise<ISkillFile> {
    const path = skillPath(id);
    if (!/^common\/[^/]+$/.test(path)) {
        throw new BadRequestException('Выберите скилл общего каталога.');
    }
    if (!(await storage.existsSkill(path))) {
        throw new NotFoundException('Скилл отсутствует в каталоге.');
    }
    const current = await storage.readSkill(path);
    if (requestKey && current.meta.assetArchive?.requestKey === requestKey) {
        if (
            current.meta.assetArchive.previousHash !== expected.hash ||
            current.meta.assetArchive.payloadHash !== fingerprint(skillCreateFromFile(current)) ||
            current.meta.assetArchive.version !== current.meta.version ||
            current.meta.assetArchive.restore !== restore ||
            !!current.meta.archivedAt === restore
        ) {
            throw new ConflictException('Скилл изменился после сохранённого архивирования.');
        }
        return current;
    }
    if (
        expected.id !== path ||
        importedSkillSnapshot(current).hash !== expected.hash ||
        current.meta.version !== expected.version
    ) {
        throw new ConflictException('Скилл изменился после проверки последствий.');
    }
    if (!!current.meta.archivedAt === !restore) {
        return current;
    }
    if (restore) validateSkillCreate(skillCreateFromFile(current));
    const now = new Date().toISOString(),
        version = current.meta.version + 1;
    const meta: ISkillMeta = {
        ...current.meta,
        version,
        updatedAt: now,
        history: [
            ...current.meta.history,
            { version, at: now, author: actor, note: restore ? 'Возвращён из архива' : 'Убран из общего каталога' },
        ],
    };
    if (requestKey) {
        meta.assetArchive = {
            requestKey,
            previousHash: expected.hash,
            payloadHash: fingerprint(skillCreateFromFile(current)),
            version,
            restore,
        };
    }
    if (restore) {
        delete meta.archivedAt;
    } else {
        meta.archivedAt = now;
    }
    await storage.writeSkill(path, meta, current.body, current.resources, { actor, source: 'editor' }, current);
    return storage.readSkill(path);
}
