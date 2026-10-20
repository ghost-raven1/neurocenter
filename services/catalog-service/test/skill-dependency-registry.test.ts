import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { buildPackage } from '../src/catalog/bundle-package';
import { PluginRepository } from '../src/publication/plugin-repository';
import { reserveSkillDependencies, setupSkillDependencyReservations } from '../src/publication/skill-dependency-registry';

const config = { transport: 'remote' as const, url: 'https://example.test/mcp' };
const dependency = { id: 'ai-plug-reserved', name: 'Закреплённый MCP', kind: 'mcp', files: [], config, metadata: { kind: 'mcp' } };
const pin = { kind: 'mcp', id: dependency.id, version: 1,
    manifest: buildPackage({ id: dependency.id, name: dependency.name, kind: 'mcp', version: 1 }, [], 'now', config).manifest.sha256 };
const entry = { key: 'a'.repeat(64), path: 'shared/project-search', dependencies: [pin] };

describe('Неизменяемые резервы зависимостей скиллов', () => {
    let pool: Pool;
    let query: ReturnType<typeof vi.fn>;
    let release: ReturnType<typeof vi.fn>;
    let stored: unknown[] | undefined;

    beforeEach(() => {
        stored = undefined;
        query = vi.fn(async (sql: string) => {
            if (sql.includes('JOIN ai_plugin_versions')) { return { rows: [dependency] }; }
            if (sql.startsWith('SELECT dependencies FROM skill_dependency_reservations')) { return { rows: stored ? [{ dependencies: stored }] : [] }; }
            return { rows: [] };
        });
        release = vi.fn();
        pool = { query, connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
    });

    it('Создаёт таблицу метаданных без тела и исходников скилла', async () => {
        await setupSkillDependencyReservations(pool);
        const sql = query.mock.calls[0][0];
        expect(sql).toContain('PRIMARY KEY(key,skill_path)');
        expect(sql).toContain('dependencies JSONB');
        expect(sql).not.toMatch(/body|content|resources/);
    });

    it('Проверяет точную версию под блокировкой графа и сохраняет только pins', async () => {
        expect(await reserveSkillDependencies(pool, { entries: [entry] })).toEqual({ reserved: 1 });
        expect(query.mock.calls[1]).toEqual(['SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['publication:dependency-graph']]);
        expect(query.mock.calls.find(([sql]) => sql.includes('JOIN ai_plugin_versions'))?.[1]).toEqual([pin.id, pin.version]);
        expect(query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO skill_dependency_reservations'))?.[1]).toEqual([entry.key, entry.path, JSON.stringify([pin])]);
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
        expect(release).toHaveBeenCalledOnce();
    });

    it('Повтор того же снимка не создаёт новый резерв', async () => {
        stored = [pin];
        await expect(reserveSkillDependencies(pool, { entries: [entry] })).resolves.toEqual({ reserved: 1 });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT '))).toBe(false);
    });

    it('Тот же ключ и путь с другими pins отклоняются без изменения резерва', async () => {
        stored = [];
        await expect(reserveSkillDependencies(pool, { entries: [entry] })).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE) /.test(sql))).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(release).toHaveBeenCalledOnce();
    });

    it('Несовпадающий SHA откатывает весь пакет резервов', async () => {
        const bad = { ...entry, key: 'b'.repeat(64), dependencies: [{ ...pin, manifest: 'c'.repeat(64) }] };
        await expect(reserveSkillDependencies(pool, { entries: [entry, bad] })).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT '))).toBe(true);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it.each([
        null, { entries: 'invalid' }, { entries: Array(201).fill(entry) }, { entries: [entry], body: 'secret' },
        { entries: [{ ...entry, key: '../bad' }] }, { entries: [{ ...entry, path: '../shared' }] },
        { entries: [{ ...entry, path: 'shared/Uppercase' }] }, { entries: [{ ...entry, path: '' }] },
        { entries: [{ ...entry, dependencies: undefined }] }, { entries: [{ ...entry, dependencies: Array(21).fill(pin) }] },
        { entries: [{ ...entry, body: 'secret' }] }, { entries: [{ ...entry, dependencies: [{ ...pin, version: 0 }] }] },
    ])('Повреждённые метаданные не открывают транзакцию: %j', async input => {
        await expect(reserveSkillDependencies(pool, input)).rejects.toMatchObject({ status: 400 });
        expect(pool.connect).not.toHaveBeenCalled();
    });

    it('Архив сохраняет резервы и immutable версии без прежней сетевой проверки удаления', async () => {
        query.mockImplementation(async (sql:string)=>({rows:sql.startsWith('SELECT * FROM ai_plugins WHERE')?[{...dependency,description:'',version:1,dependencies:[],tags:[],origin:'upload'}]:[]}));
        await expect(new PluginRepository(pool).delete(pin.id,'qa')).resolves.toBe(true);
        expect(query.mock.calls.some(([sql])=>sql.startsWith('DELETE '))).toBe(false);
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE ai_plugins SET archived_at'))).toBe(true);
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
    });
});
