import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { buildPackage } from '../src/catalog/bundle-package';
import { PluginRepository } from '../src/publication/plugin-repository';
import { assertRemoteSkillUnreferenced, reserveSkillDependencies, setupSkillDependencyReservations } from '../src/publication/skill-dependency-registry';

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

    it('Резерв блокирует удаление до сетевой проверки и записи аудита', async () => {
        const remote = vi.fn(async () => {});
        query.mockImplementation(async (sql: string) => {
            if (sql.startsWith('SELECT * FROM ai_plugins WHERE')) { return { rows: [{ ...dependency, description: '', version: 1, dependencies: [], tags: [], origin: 'upload' }] }; }
            if (sql.startsWith('SELECT 1 FROM skill_dependency_reservations')) { return { rows: [{ exists: 1 }] }; }
            return { rows: [] };
        });
        await expect(new PluginRepository(pool, remote).delete(pin.id, 'qa')).rejects.toMatchObject({ status: 409 });
        expect(remote).not.toHaveBeenCalled();
        expect(query.mock.calls.some(([sql]) => /^(DELETE|INSERT) /.test(sql))).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it('Недоступная проверка старого хранилища откатывает удаление', async () => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT * FROM ai_plugins WHERE')
            ? [{ ...dependency, description: '', version: 1, dependencies: [], tags: [], origin: 'upload' }] : [] }));
        const remote = vi.fn(async () => { throw new Error('Проверка недоступна'); });
        await expect(new PluginRepository(pool, remote).delete(pin.id, 'qa')).rejects.toThrow('Проверка недоступна');
        expect(remote).toHaveBeenCalledWith(pin.id);
        expect(query.mock.calls.some(([sql]) => /^(DELETE|INSERT) /.test(sql))).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });
});

describe('Проверка ссылок в файловом сервисе перед удалением', () => {
    beforeEach(() => {
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'owned-test-token');
        vi.stubEnv('SKILLS_SERVICE_URL', 'http://skills.internal:4200');
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

    it('Передаёт служебный токен и точный ID, ограничивает ожидание и запрещает перенаправления', async () => {
        const request = vi.fn(async () => ({ status: 200, json: async () => ({ inUse: false }) }));
        vi.stubGlobal('fetch', request);
        await expect(assertRemoteSkillUnreferenced(pin.id)).resolves.toBeUndefined();
        const [url, options] = request.mock.calls[0] as unknown as [URL, RequestInit];
        expect(url.toString()).toBe('http://skills.internal:4200/internal/skill-dependencies/usage?assetId=ai-plug-reserved');
        expect(options).toMatchObject({ headers: { 'x-neurocenter-internal': 'owned-test-token' }, redirect: 'error' });
        expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('Текущая или историческая ссылка возвращает конфликт', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ inUse: true }) })));
        await expect(assertRemoteSkillUnreferenced(pin.id)).rejects.toMatchObject({ status: 409 });
    });

    it.each([null, [], {}, { inUse: 'false' }, { inUse: false, files: ['secret'] }])('Повреждённый ответ не разрешает удаление: %j', async body => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => body })));
        await expect(assertRemoteSkillUnreferenced(pin.id)).rejects.toMatchObject({ status: 503 });
    });

    it.each(['status', 'network', 'json', 'token', 'url'])('Отказ %s останавливает удаление без утечки конфигурации', async failure => {
        if (failure === 'token') { vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', ''); }
        if (failure === 'url') { vi.stubEnv('SKILLS_SERVICE_URL', 'not-a-url'); }
        vi.stubGlobal('fetch', vi.fn(async () => {
            if (failure === 'network') { throw new Error('owned-test-token'); }
            return { status: failure === 'status' ? 500 : 200, json: async () => {
                if (failure === 'json') { throw new Error('owned-test-token'); }
                return { inUse: false };
            } };
        }));
        await expect(assertRemoteSkillUnreferenced(pin.id)).rejects.toMatchObject({ status: 503 });
        await expect(assertRemoteSkillUnreferenced(pin.id)).rejects.not.toThrow('owned-test-token');
    });
});
