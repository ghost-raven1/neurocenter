import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessDb } from '../src/access/access-db';

const mock = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock('../src/database/pool', () => ({ createPool: () => ({ connect: async () => mock }) }));
const user = { email: 'member@example.invalid', displayName: 'Участник', isMainAdmin: false, enabled: true };
const current = { email: user.email, display_name: user.displayName, is_main_admin: false, enabled: true };

describe('Аудит учётной записи при выдаче проектного доступа', () => {
    beforeEach(() => {
        mock.release.mockReset();
        mock.query.mockReset().mockImplementation(async (sql: string) => {
            if (sql.startsWith('SELECT * FROM platform_users')) { return { rows: [current] }; }
            if (sql.startsWith('INSERT INTO platform_users')) { return { rows: [user] }; }
            return { rows: [] };
        });
    });

    it('Не выдаёт неизменившуюся учётную запись за административное изменение', async () => {
        await new AccessDb().save({ email: user.email }, 'admin@example.invalid');
        expect(mock.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO security_events'))).toBe(false);
        expect(mock.query.mock.calls.at(-1)).toEqual(['COMMIT']);
    });

    it('Сначала проверяет конфликт черновика, даже если само сохранение было бы без изменений', async () => {
        await expect(new AccessDb().save({ email: user.email, expected: { displayName: 'Старое имя', isMainAdmin: false, enabled: true } }, 'admin@example.invalid')).rejects.toThrow('Пользователя уже изменили');
        expect(mock.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO security_events'))).toBe(false);
        expect(mock.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it('Создание сохраняет переданного исполнителя в той же транзакции', async () => {
        mock.query.mockImplementation(async (sql: string) => sql.startsWith('INSERT INTO platform_users') ? { rows: [user] } : { rows: [] });
        await new AccessDb().save({ email: user.email }, 'admin@example.invalid');
        const event = mock.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO security_events'))![1];
        expect(event.slice(1, 4)).toEqual(['admin@example.invalid', 'user.create', user.email]);
        expect(mock.query.mock.calls.at(-1)).toEqual(['COMMIT']);
    });
});
