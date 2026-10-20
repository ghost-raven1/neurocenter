import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { PluginRepository } from '../src/publication/plugin-repository';
import type { IAiPlugin } from '../src/catalog/dto';
const card=(overrides:Partial<IAiPlugin>={}):IAiPlugin=>({id:'ai-plug-existing',name:'Инструмент',kind:'mcp',version:1,description:'Описание',tags:[],origin:'upload',revision:null,compatibility:null,files:[],config:null,createdAt:'then',updatedAt:'then',...overrides});
describe('Квитанция обновления входит в транзакцию репозитория', () => {
    it('Отказ записи квитанции откатывает версию и аудит, включая заимствованного клиента', async () => {
        const current = card({ config: { transport: 'remote', url: 'https://example.test/mcp' } });
        const row = { ...current, created_at: 'then', updated_at: 'then', dependencies: [] };
        const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
            if (sql.startsWith('SELECT * FROM ai_plugins')) { return { rows: [row] }; }
            if (sql.startsWith('SELECT GREATEST')) { return { rows: [{ v: 2 }] }; }
            if (sql.startsWith('UPDATE ai_plugins')) { return { rows: [{ ...row, version: 2, description: parameters![1] }] }; }
            return { rows: [] };
        });
        const client = { query, release: vi.fn() } as unknown as PoolClient, connect = vi.fn();
        const repository = new PluginRepository({ connect } as unknown as Pool);
        await expect(repository.update(current.id, { expectedVersion: 1, description: 'Обновлено' }, 'asset-import', async () => {
            throw new Error('Квитанция не сохранена');
        }, client)).rejects.toThrow('Квитанция не сохранена');
        expect(connect).not.toHaveBeenCalled(); expect(client.release).not.toHaveBeenCalled();
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO security_events'))).toBe(true);
    });
    it('Внешняя транзакция остаётся у владельца при успешной записи и при отказе квитанции', async () => {
        const current = card({ config: { transport: 'remote', url: 'https://example.test/mcp' } });
        const row = { ...current, created_at: 'then', updated_at: 'then', dependencies: [] };
        for (const failure of [false, true]) {
            const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT * FROM ai_plugins') ? [row] : [] }));
            const client = { query, release: vi.fn() } as unknown as PoolClient;
            const repository = new PluginRepository({ connect: vi.fn() } as unknown as Pool);
            const finish = vi.fn(async () => { if (failure) { throw new Error('Контролируемый отказ'); } });
            const update = repository.update(current.id, { expectedVersion: 1, description: current.description }, 'asset-import', finish, client, true);
            if (failure) { await expect(update).rejects.toThrow('Контролируемый отказ'); }
            else { await expect(update).resolves.toMatchObject({ id: current.id }); }
            expect(finish).toHaveBeenCalledOnce(); expect(client.release).not.toHaveBeenCalled();
            expect(query.mock.calls.some(([sql]) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql))).toBe(false);
        }
    });
});
