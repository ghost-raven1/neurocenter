import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { buildPackage } from '../src/catalog/bundle-package';
import { PluginRepository } from '../src/publication/plugin-repository';

const config = { transport: 'remote' as const, url: 'https://example.test/mcp' };
const dependency = { id: 'ai-plug-dependency', name: 'Зависимость', kind: 'mcp', version: 1, files: [], config,
    metadata: { kind: 'mcp', dependencies: [] } };
const pin = { kind: 'mcp' as const, id: dependency.id, version: 1,
    manifest: buildPackage({ id: dependency.id, name: dependency.name, kind: 'mcp', version: 1 }, [], 'now', config).manifest.sha256 };
const row = { id: 'ai-plug-root', name: 'Главный инструмент', kind: 'mcp', description: 'Описание', version: 1,
    compatibility: null, tags: [], origin: 'upload', revision: null, config, files: [], dependencies: [],
    created_at: '2026-10-18', updated_at: '2026-10-18' };
const input = { name: row.name, kind: 'mcp' as const, description: row.description, config, dependencies: [pin] };

describe('Целостность закреплённых зависимостей при записи публикации', () => {
    let repository: PluginRepository;
    let query: ReturnType<typeof vi.fn>;
    let savedDependency: Record<string, unknown> | undefined;
    let referenced: boolean;

    beforeEach(() => {
        savedDependency = { ...dependency };
        referenced = false;
        query = vi.fn(async (sql: string, params?: unknown[]) => {
            if (sql.includes('JOIN ai_plugin_versions')) { return { rows: savedDependency ? [savedDependency] : [] }; }
            if (sql.includes('dependencies @>') || sql.includes("metadata->'dependencies'")) { return { rows: referenced ? [{ exists: 1 }] : [] }; }
            if (sql.startsWith('SELECT * FROM ai_plugins WHERE id=')) { return { rows: [row] }; }
            if (sql.startsWith('SELECT * FROM ai_plugin_versions WHERE')) {
                return { rows: [{ version: 1, files: [], config, metadata: { kind: 'mcp', dependencies: [pin] } }] };
            }
            if (sql.startsWith('INSERT INTO ai_plugins')) { return { rows: [{ ...row, dependencies: [pin] }] }; }
            if (sql.startsWith('SELECT GREATEST')) { return { rows: [{ v: 2 }] }; }
            if (sql.startsWith('UPDATE ai_plugins')) { return { rows: [{ ...row, version: 2, dependencies: JSON.parse(String(params![9])) }] }; }
            return { rows: [] };
        });
        repository = new PluginRepository({ connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool);
    });

    const write = (repository: PluginRepository, action: string) => action === 'create'
        ? repository.create(input, 'qa-author') : action === 'update'
            ? repository.update(row.id, { dependencies: [pin], expectedVersion: 1 }, 'qa-author')
            : repository.activate(row.id, 1, 'qa-author');

    it.each(['create', 'update', 'activate'])('%s повторно проверяет точную версию и SHA в транзакции', async action => {
        await write(repository, action);
        expect(query.mock.calls[1]).toEqual(['SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['publication:dependency-graph']]);
        const read = query.mock.calls.find(([sql]) => sql.includes('JOIN ai_plugin_versions'));
        expect(read?.[1]).toEqual([pin.id, pin.version]);
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
    });

    it.each(['create', 'update', 'activate'])('%s отклоняет пропавшую закреплённую версию без записи', async action => {
        savedDependency = undefined;
        await expect(write(repository, action)).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.some(([sql]) => /^(INSERT INTO|UPDATE|DELETE FROM) /.test(sql))).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it.each([
        { metadata: { kind: 'plugin', dependencies: [] } },
        { config: { ...config, url: 'https://changed.test/mcp' } },
        { files: [{ path: 'changed.txt', content: 'Изменённая версия' }] },
    ])('Отказывает при несовпадении типа или содержимого точной версии: %j', async change => {
        savedDependency = { ...dependency, ...change };
        await expect(repository.create(input, 'qa-author')).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it('Вычисляет SHA исторического снимка с его собственными pins, а не с текущим head', async () => {
        const nestedVersion = { ...dependency, id: 'ai-plug-nested', name: 'Вложенная зависимость' };
        const nested = { ...pin, id: nestedVersion.id, manifest: buildPackage({ id: nestedVersion.id, name: nestedVersion.name, kind: 'mcp', version: 1 }, [], 'now', config).manifest.sha256 };
        const originalQuery = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, params?: unknown[]) => sql.includes('JOIN ai_plugin_versions') && params?.[0] === nested.id
            ? { rows: [nestedVersion] } : originalQuery(sql, params));
        const historicalConfig = { ...config, extra: { requirements: { mcp: [], plugins: [], dependencies: [nested] } } };
        const historicalPin = { ...pin, manifest: buildPackage({ id: dependency.id, name: dependency.name, kind: 'mcp', version: 1 }, [], 'now', historicalConfig).manifest.sha256 };
        savedDependency = { ...dependency, metadata: { kind: 'mcp', dependencies: [nested] } };
        await expect(repository.create({ ...input, dependencies: [historicalPin] }, 'qa-author')).resolves.toMatchObject({ id: row.id });
    });

    it('Используемая в чужом head или истории зависимость не удаляется', async () => {
        referenced = true;
        await expect(repository.delete(row.id, 'qa-author')).rejects.toMatchObject({ status: 409 });
        const read = query.mock.calls.find(([sql]) => sql.includes("metadata->'dependencies'"));
        expect(read?.[0]).toContain('ai_plugin_id<>$1');
        expect(read?.[1]).toEqual([row.id, JSON.stringify([{ id: row.id }])]);
        expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE '))).toBe(false);
    });
});
