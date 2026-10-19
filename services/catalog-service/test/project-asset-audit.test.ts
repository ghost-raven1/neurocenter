import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CatalogDb } from '../src/catalog/catalog-db';

const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), release: vi.fn() }));
vi.mock('../src/database/pool', () => ({ createPool: () => ({ query: mocks.query, connect: mocks.connect }) }));

const row = { project_id: 'prj-example', asset_id: 'ai-plug-example', asset_kind: 'mcp', added_by: 'first@example.test', added_at: '2026-10-18T14:00:00Z' };
const actor = 'operator@example.test';
const events = () => mocks.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO security_events'));

describe('Транзакционный аудит состава проектного каталога', () => {
    let db: CatalogDb;
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.query.mockImplementation(async (sql: string) => {
            if (sql.includes('FROM ai_plugins')) { return { rows: [{ id: row.asset_id, kind: row.asset_kind }] }; }
            if (sql.startsWith('INSERT INTO project_assets') || sql.startsWith('DELETE FROM project_assets')) { return { rows: [row], rowCount: 1 }; }
            return { rows: [] };
        });
        mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
        db = new CatalogDb('postgresql://test-only');
    });

    it('Добавление фиксирует область, инструмент и исполнителя до COMMIT', async () => {
        await db.addProjectAsset(row.project_id, row.asset_id, 'mcp', actor);
        expect(events()).toHaveLength(1);
        const payload = events()[0][1] as unknown[];
        expect(payload.slice(1, 4)).toEqual([actor, 'project.asset.add', `${row.project_id} · mcp · ${row.asset_id}`]);
        expect(JSON.parse(String(payload[4]))).toBeNull();
        expect(JSON.parse(String(payload[5]))).toMatchObject({ projectId: row.project_id, assetId: row.asset_id, assetKind: 'mcp' });
        expect(mocks.query.mock.calls.at(-1)).toEqual(['COMMIT']);
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it('Удаление хранит прежнее назначение отдельно от исполнителя удаления', async () => {
        expect(await db.removeProjectAsset(row.project_id, row.asset_id, 'mcp', actor)).toBe(true);
        const payload = events()[0][1] as unknown[];
        expect(payload.slice(1, 3)).toEqual([actor, 'project.asset.remove']);
        expect(JSON.parse(String(payload[4]))).toMatchObject({ projectId: row.project_id, addedBy: row.added_by });
        expect(JSON.parse(String(payload[5]))).toBeNull();
    });

    it.each(['add', 'remove'])('Ошибка аудита откатывает %s вместе с назначением', async operation => {
        const original = mocks.query.getMockImplementation()!;
        mocks.query.mockImplementation(async (sql: string) => {
            if (sql.startsWith('INSERT INTO security_events')) { throw new Error('Журнал недоступен'); }
            return original(sql);
        });
        const result = operation === 'add' ? db.addProjectAsset(row.project_id, row.asset_id, 'mcp', actor)
            : db.removeProjectAsset(row.project_id, row.asset_id, 'mcp', actor);
        await expect(result).rejects.toThrow('Журнал недоступен');
        expect(mocks.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(mocks.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    });

    it('Повтор добавления и отсутствие удаляемой ссылки не создают события', async () => {
        const original = mocks.query.getMockImplementation()!;
        mocks.query.mockImplementation(async (sql: string) => /^(INSERT INTO|DELETE FROM) project_assets/.test(sql) ? { rows: [], rowCount: 0 } : original(sql));
        await db.addProjectAsset(row.project_id, row.asset_id, 'mcp', actor);
        expect(await db.removeProjectAsset(row.project_id, row.asset_id, 'mcp', actor)).toBe(false);
        expect(events()).toHaveLength(0);
    });

    it('Назначение блокирует существующую карточку до INSERT для совместимости с DELETE', async () => {
        await db.addProjectAsset(row.project_id, row.asset_id, 'mcp', actor);
        expect(mocks.query.mock.calls.find(([sql]) => sql.includes('FROM ai_plugins'))?.[0]).toContain('FOR KEY SHARE');
    });

    it('Отсутствующий или неверно указанный тип карточки не оставляет ссылку и аудит', async () => {
        const original = mocks.query.getMockImplementation()!;
        mocks.query.mockImplementation(async (sql: string) => sql.includes('FROM ai_plugins') ? { rows: [] } : original(sql));
        await expect(db.addProjectAsset(row.project_id, row.asset_id, 'mcp', actor)).rejects.toMatchObject({ status: 404 });
        mocks.query.mockImplementation(async (sql: string) => sql.includes('FROM ai_plugins') ? { rows: [{ id: row.asset_id, kind: 'plugin' }] } : original(sql));
        await expect(db.addProjectAsset(row.project_id, row.asset_id, 'mcp', actor)).rejects.toMatchObject({ status: 400 });
        expect(events()).toHaveLength(0);
        expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO project_assets'))).toBe(false);
    });
});
