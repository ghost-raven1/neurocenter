import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { PluginRepository } from '../src/publication/plugin-repository';

const row = { id: 'ai-plug-delete', name: 'Удаляемый MCP', kind: 'mcp', description: 'Описание', version: 3,
    compatibility: null, tags: [], origin: 'upload', revision: '1.0.0', dependencies: [],
    config: { transport: 'remote', url: 'https://example.test/mcp', headers: { Authorization: 'private-token' } },
    files: [{ path: 'notes.txt', content: 'private-source' }], created_at: '2026-10-18', updated_at: '2026-10-18' };
const actor = 'operator@example.test';

describe('Удаление MCP/плагина и транзакционный аудит', () => {
    let query: ReturnType<typeof vi.fn>;
    let release: ReturnType<typeof vi.fn>;
    let repository: PluginRepository;

    beforeEach(() => {
        query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT * FROM ai_plugins WHERE') ? [row] : [] }));
        release = vi.fn();
        repository = new PluginRepository({ connect: async () => ({ query, release }) } as unknown as Pool, async () => {});
    });

    const events = (query: ReturnType<typeof vi.fn>) => query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO security_events'));

    it('Сохраняет исполнителя и отпечаток удалённой версии до COMMIT без исходников и настроек', async () => {
        expect(await repository.delete(row.id, actor)).toBe(true);
        expect(events(query)).toHaveLength(1);
        const event = events(query)[0][1] as unknown[];
        expect(event.slice(1, 4)).toEqual([actor, 'plugin.delete', row.id]);
        expect(JSON.parse(String(event[4]))).toMatchObject({ id: row.id, name: row.name, kind: 'mcp', version: 3,
            filesCount: 1, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(JSON.parse(String(event[5]))).toBeNull();
        expect(JSON.stringify(event)).not.toMatch(/private-token|private-source|Authorization/);
        expect(query.mock.calls.find(([sql]) => sql.includes('FROM ai_plugins WHERE'))?.[0]).toContain('FOR UPDATE');
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
        expect(release).toHaveBeenCalledOnce();
    });

    it('Отказ аудита откатывает удаление карточки и истории версий', async () => {
        const original = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string) => {
            if (sql.startsWith('INSERT INTO security_events')) { throw new Error('Аудит недоступен'); }
            return original(sql);
        });
        await expect(repository.delete(row.id, actor)).rejects.toThrow('Аудит недоступен');
        expect(query.mock.calls.some(([sql]) => sql === 'DELETE FROM ai_plugin_versions WHERE ai_plugin_id=$1')).toBe(true);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(release).toHaveBeenCalledOnce();
    });

    it('Отсутствующая карточка не создаёт ложное событие удаления', async () => {
        query.mockResolvedValue({ rows: [] });
        expect(await repository.delete(row.id, actor)).toBe(false);
        expect(events(query)).toHaveLength(0);
        expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE '))).toBe(false);
    });

    it('Используемый инструмент остаётся на месте и не получает успешного события', async () => {
        const original = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string) => sql.includes('FROM project_assets') ? { rows: [{ exists: 1 }] } : original(sql));
        await expect(repository.delete(row.id, actor)).rejects.toThrow('Инструмент используется');
        expect(events(query)).toHaveLength(0);
        expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE '))).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });
});
