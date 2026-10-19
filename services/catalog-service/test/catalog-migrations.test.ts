import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateCatalog } from '../src/database/migrations';

describe('Версионные миграции каталога', () => {
    const first = { version: 1, name: 'первая', sql: 'CREATE TABLE example(id integer)' };
    const checksum = createHash('sha256').update(first.sql).digest('hex');
    const query = vi.fn();
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
    beforeEach(() => { query.mockReset().mockResolvedValue({ rows: [] }); release.mockClear(); });

    it('Фиксирует схему и её контрольную сумму одной транзакцией', async () => {
        await migrateCatalog(pool, [first]);
        expect(query.mock.calls.map(call => call[0])).toEqual([
            'BEGIN', expect.stringContaining('pg_advisory_xact_lock'), expect.stringContaining('CREATE TABLE IF NOT EXISTS catalog_schema_migrations'),
            'SELECT version,name,checksum FROM catalog_schema_migrations ORDER BY version', first.sql,
            'INSERT INTO catalog_schema_migrations(version,name,checksum) VALUES($1,$2,$3)', 'COMMIT',
        ]);
        expect(query.mock.calls[5][1]).toEqual([1, 'первая', checksum]);
        expect(release).toHaveBeenCalledOnce();
    });
    it('Повторный запуск не исполняет уже принятую миграцию', async () => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT version') ? [{ ...first, checksum }] : [] }));
        await migrateCatalog(pool, [first]);
        expect(query.mock.calls.some(([sql]) => sql === first.sql)).toBe(false);
        expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    });
    it.each([
        { rows: [{ version: 1, name: 'первая', checksum: 'изменена' }] },
        { rows: [{ version: 1, name: 'другая', checksum }] },
        { rows: [{ version: 2, name: 'первая', checksum }] },
        { rows: [{ version: 1, name: 'первая', checksum }, { version: 2, name: 'будущая', checksum }] },
    ])('Изменение истории или запуск старой сборки блокирует запись: %j', async ({ rows }) => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT version') ? rows : [] }));
        await expect(migrateCatalog(pool, [first])).rejects.toThrow('История миграций');
        expect(query.mock.calls.some(([sql]) => sql === first.sql)).toBe(false);
        expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    });
    it('Ошибка DDL откатывает миграцию без записи номера версии', async () => {
        query.mockImplementation(async (sql: string) => { if (sql === first.sql) { throw new Error('Нет места'); } return { rows: [] }; });
        await expect(migrateCatalog(pool, [first])).rejects.toThrow('Нет места');
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
        expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
        expect(release).toHaveBeenCalledOnce();
    });
    it('Пропущенный номер не начинает транзакцию', async () => {
        await expect(migrateCatalog(pool, [first, { ...first, version: 3 }])).rejects.toThrow('последовательные');
        expect(query).not.toHaveBeenCalled();
    });
});
