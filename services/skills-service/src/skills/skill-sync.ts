import type { ISkillMutationContext } from '../storage/skill-audit';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ISkillsStorage } from '../storage/skills-storage.interface';
import type { ISkillFile, ISkillMeta, ISkillsSyncItem, ISkillsSyncResult } from './skills.model';
import { skillPath, validateSkillCreate, assertSkillDependencyReplacement } from './skill-validation';

/** Пакет полностью проверяется до записи; вызывается под блокировкой коллекции. */
export async function syncProjectSkills(
    storage: ISkillsStorage,
    projectKey: string,
    items: ISkillsSyncItem[],
    context?: ISkillMutationContext,
): Promise<ISkillsSyncResult> {
    if (!projectKey || skillPath(projectKey) !== projectKey || projectKey.includes('/') || !Array.isArray(items)) {
        throw new BadRequestException('Нужны ID проекта и массив карточек скиллов.');
    }

    const directory = 'project-' + projectKey;
    const seen = new Set<string>();

    const inputs = items.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new BadRequestException('Карточка скилла должна быть объектом.');
        }

        const input = validateSkillCreate({
            path: directory,
            slug: item.slug,
            name: item.name,
            body: item.body as string,
            meta: {
                description: item.description,
                mcp: item.mcp,
                plugins: item.plugins,
                tags: item.tags,
                specialization: item.specialization,
                dependencies: item.dependencies,
            },
        });

        if (seen.has(input.slug)) {
            throw new BadRequestException('Идентификаторы скиллов не должны повторяться.');
        }

        seen.add(input.slug);

        if (item.version !== undefined && (!Number.isSafeInteger(item.version) || item.version < 1)) {
            throw new BadRequestException('Версия скилла должна быть положительным целым числом.');
        }

        return {
            input,
            version: item.version,
            dependenciesSpecified: item.dependencies !== undefined,
            replacement: {
                mcp: item.mcp,
                plugins: item.plugins,
                ...(item.dependencies !== undefined ? { dependencies: item.dependencies } : {}),
            },
        };
    });

    const entries = (await storage.listDir(directory)).filter((entry) => !entry.isDir && entry.name.endsWith('.md'));

    if (!inputs.length && entries.length) {
        throw new ConflictException(
            'Пустой источник не удаляет инструкции. Проверьте локальный каталог; отдельные скиллы можно удалить явно.',
        );
    }

    const before = new Map<string, ISkillFile>();

    for (const entry of entries) {
        const file = await storage.readSkill(directory + '/' + entry.name.slice(0, -3));

        before.set(file.path, file);
    }

    const changes: Array<{
        path: string;
        next: ISkillFile | null;
    }> = [];

    const now = new Date().toISOString();
    let upserted = 0;

    for (const { input, version, dependenciesSpecified, replacement } of inputs) {
        const relative = directory + '/' + input.slug;
        const previous = before.get(relative);

        if (previous) {
            assertSkillDependencyReplacement(previous.meta, replacement);
        }

        if (previous && version !== undefined && version < previous.meta.version) {
            throw new ConflictException(
                `Скилл «${input.name}» уже изменён на сервере. Загрузите актуальную версию перед синхронизацией.`,
            );
        }

        const dependencies = dependenciesSpecified ? input.meta?.dependencies : previous?.meta.dependencies;

        const fields = {
            name: input.name,
            slug: input.slug,
            scope: 'project' as const,
            projectId: projectKey,
            description: input.meta?.description,
            mcp: input.meta?.mcp || [],
            plugins: input.meta?.plugins || [],
            tags: input.meta?.tags || [],
            specialization: input.meta?.specialization,
            dependencies: dependencies?.length ? dependencies : undefined,
        };

        const same =
            previous &&
            previous.body === input.body &&
            Object.entries(fields).every(
                ([key, value]) => JSON.stringify(previous.meta[key as keyof ISkillMeta]) === JSON.stringify(value),
            );

        const lastAuthor = previous?.meta.history[previous.meta.history.length - 1]?.author ?? previous?.meta.owner;

        if (previous && !same && version === undefined && lastAuthor !== 'mcp-sync') {
            throw new ConflictException(
                `Скилл «${input.name}» изменён в редакторе. Перед синхронизацией передайте его актуальную версию.`,
            );
        }

        if (same && (version === undefined || version === previous.meta.version)) {
            continue;
        }

        const nextVersion = previous ? Math.max(previous.meta.version + 1, version || 1) : version || 1;

        const meta: ISkillMeta = {
            ...fields,
            generation: previous ? previous.meta.generation : randomUUID(),
            owner: previous?.meta.owner || 'mcp-sync',
            version: nextVersion,
            updatedAt: now,
            history: [
                ...(previous?.meta.history || []),
                {
                    version: nextVersion,
                    at: now,
                    author: 'mcp-sync',
                    note: 'Синхронизировано через MCP',
                },
            ],
        };

        changes.push({
            path: relative,
            next: {
                path: relative,
                meta,
                body: input.body,
                ...(previous?.resources ? { resources: previous.resources } : {}),
            },
        });

        upserted++;
    }

    for (const [relative, previous] of before) {
        if (seen.has(relative.slice(directory.length + 1))) {
            continue;
        }

        const lastAuthor = previous.meta.history[previous.meta.history.length - 1]?.author ?? previous.meta.owner;

        if (lastAuthor !== 'mcp-sync') {
            throw new ConflictException(
                `Скилл «${previous.meta.name}» отсутствует в локальном источнике и содержит правки редактора. Загрузите актуальный набор или удалите этот скилл явно в редакторе.`,
            );
        }

        changes.push({
            path: relative,
            next: null,
        });
    }

    await storage.applySkillChanges(changes, context);

    return {
        projectKey,
        upserted,
        removed: changes.filter((change) => change.next === null).length,
        total: inputs.length,
    };
}
