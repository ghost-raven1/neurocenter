import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool,PoolClient } from 'pg';

import { PluginRepository } from '../src/publication/plugin-repository';

const input = { name: 'Поиск проекта', kind: 'mcp' as const, description: 'Поиск документов', revision: '1.2.3',
    config: { transport: 'remote' as const, url: 'https://example.test/mcp' }, publicationKey: '7428c85e-c645-4f05-b610-6f0029867f93' }; // gitleaks:allow — тестовый UUID идемпотентного запроса, не ключ доступа.
const row = { id: 'ai-plug-test', name: input.name, kind: input.kind, description: input.description, version: 1,
    compatibility: null, tags: [], origin: 'upload', revision: input.revision, config: input.config, files: [], dependencies: [],
    created_at: '2026-10-18', updated_at: '2026-10-18', publication_hash: '' };

describe('Транзакционный аудит публикаций каталога', () => {
    let repository: PluginRepository;
    let query: ReturnType<typeof vi.fn>;
    let connect: ReturnType<typeof vi.fn>;
    let release: ReturnType<typeof vi.fn>;
    let savedRow: typeof row;

    beforeEach(() => {
        savedRow = { ...row };
        query = vi.fn(async (sql: string, params?: unknown[]) => {
            if (sql.startsWith('SELECT * FROM ai_plugins WHERE id=')) { return { rows: [row] }; }
            if (sql.startsWith('INSERT INTO ai_plugins')) { return { rows: [row] }; }
            if (sql.startsWith('SELECT GREATEST')) { return { rows: [{ v: 2 }] }; }
            if (sql.startsWith('UPDATE ai_plugins')) {
                savedRow = { ...row, description: String(params![1]), version: Number(params![2]) };
                return { rows: [savedRow] };
            }
            return { rows: [] };
        });
        release=vi.fn();connect=vi.fn(async()=>({query,release}));
        const pool = { connect } as unknown as Pool;
        repository = new PluginRepository(pool);
    });

    const events = (query: ReturnType<typeof vi.fn>) => query.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT INTO security_events'));

    it('Создание фиксирует автора и отпечаток версии до COMMIT, без содержимого настроек', async () => {
        await repository.create(input, 'publisher@example.test');

        const event = events(query)[0][1] as unknown[];
        expect(event.slice(1, 4)).toEqual(['publisher@example.test', 'plugin.create', row.id]);
        expect(JSON.parse(String(event[4]))).toBeNull();
        expect(JSON.parse(String(event[5]))).toEqual({ id: row.id, name: row.name, kind: 'mcp', version: 1,
            origin: 'upload', revision: '1.2.3', filesCount: 0, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(String(event[5])).not.toContain('https://');
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
        expect(connect).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledOnce();
    });

    it('Ошибка аудита откатывает публикацию вместе с первой версией', async () => {
        const original = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, params?: unknown[]) => {
            if (sql.startsWith('INSERT INTO security_events')) { throw new Error('Журнал недоступен'); }
            return original(sql, params);
        });

        await expect(repository.create(input, 'publisher@example.test')).rejects.toThrow('Журнал недоступен');
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    });

    it('Изменение сохраняет номера до и после, повтор без изменений не пишет событие', async () => {
        await repository.update(row.id, { description: 'Новый поиск', expectedVersion: 1 }, 'editor@example.test');
        const event = events(query)[0][1] as unknown[];
        expect(event[2]).toBe('plugin.update');
        const before = JSON.parse(String(event[4]));
        const after = JSON.parse(String(event[5]));
        expect(before.version).toBe(1);
        expect(after.version).toBe(2);
        expect(after.contentHash).not.toBe(before.contentHash);

        query.mockClear();
        await repository.update(row.id, { description: row.description, expectedVersion: 1 }, 'editor@example.test');
        expect(events(query)).toEqual([]);
    });

    it('Конфликт версии не создаёт успешное событие', async () => {
        await expect(repository.update(row.id, { description: 'Новый поиск', expectedVersion: 2 }, 'editor@example.test')).rejects.toThrow('Карточку уже изменили');
        expect(events(query)).toEqual([]);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it('Сбой завершения задания откатывает публикацию и аудит тем же клиентом', async () => {
        const finish = vi.fn(async client => {expect(client.query).toBe(query); throw new Error('Не сохранён результат сборки');});
        await expect(repository.create(input, 'publisher@example.test', finish)).rejects.toThrow('Не сохранён результат сборки');
        expect(finish).toHaveBeenCalledOnce();
        expect(events(query)).toHaveLength(1);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    });
    it.each([false,true])('Публикация в lease-сессии не берёт другой клиент и не освобождает владельца; rollback=%s',async rollback=>{
        const borrowedRelease=vi.fn(),borrowed={query,release:borrowedRelease} as unknown as PoolClient;
        const complete=vi.fn(async(client:PoolClient)=>{expect(client).toBe(borrowed);if(rollback)throw new Error('Контролируемый откат');});
        const publishing=repository.create(input,'publisher@example.test',complete,borrowed);
        if(rollback)await expect(publishing).rejects.toThrow('Контролируемый откат');else await expect(publishing).resolves.toMatchObject({id:row.id});
        expect(connect).not.toHaveBeenCalled();expect(borrowedRelease).not.toHaveBeenCalled();
        expect(query.mock.calls.at(-1)).toEqual([rollback?'ROLLBACK':'COMMIT']);
    });
});
