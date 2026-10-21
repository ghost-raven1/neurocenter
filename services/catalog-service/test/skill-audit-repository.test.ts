import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { SkillAuditRepository } from '../src/publication/skill-audit-repository';

const state = { generation: 'generation-1', version: 1, sha256: 'a'.repeat(64) };
const event = { id: 'f152907a-d9ab-45db-bfe1-6eac870ac624', at: '2026-10-18T14:00:00.000Z', actor: 'user@example.test',
    action: 'skill.create', resourceId: 'shared/example-skill', source: 'editor', before: null, after: state };

describe('Транзакционная доставка аудита файловых скиллов', () => {
    const query = vi.fn();
    const connect = vi.fn();
    const release = vi.fn();
    const pool = { query, connect } as unknown as Pool;
    let repository: SkillAuditRepository;
    beforeEach(() => {
        vi.clearAllMocks();
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('INSERT INTO skill_audit_receipts') ? [{ event_id: event.id }] : [] }));
        connect.mockResolvedValue({ query, release });
        repository = new SkillAuditRepository(pool);
    });
    const securityWrites = () => query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO security_events'));

    it('Сохраняет UUID, фактическое время, исполнителя и безопасные состояния до COMMIT', async () => {
        expect(await repository.record({ events: [event] })).toEqual({ accepted: 1 });
        expect(securityWrites()).toHaveLength(1);
        const parameters = securityWrites()[0][1];
        expect(parameters.slice(0, 5)).toEqual([event.id, event.at, event.actor, event.action, event.resourceId]);
        expect(JSON.parse(parameters[5])).toBeNull();
        expect(JSON.parse(parameters[6])).toEqual({ ...state, source: 'editor' });
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
        expect(release).toHaveBeenCalledOnce();
    });

    it('Подтверждает точный повтор UUID один раз и сохраняет количество входных событий', async () => {
        expect(await repository.record({ events: [event, event] })).toEqual({ accepted: 2 });
        expect(securityWrites()).toHaveLength(1);
        expect(query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO skill_audit_receipts'))).toHaveLength(1);
    });

    it('Повтор после потерянного подтверждения сверяет JSONB и не добавляет событие', async () => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT event_id FROM skill_audit_receipts') ? [{ event_id: event.id }] : [] }));
        expect(await repository.record({ events: [event] })).toEqual({ accepted: 1 });
        expect(query).toHaveBeenCalledWith(expect.stringContaining('AND payload=$2::jsonb'), [event.id, JSON.stringify(event)]);
        expect(securityWrites()).toHaveLength(0);
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
    });

    it('Повтор сохранённого UUID с другими данными даёт 409 и откатывает весь пакет', async () => {
        query.mockResolvedValue({ rows: [] });
        await expect(repository.record({ events: [event] })).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(securityWrites()).toHaveLength(0);
        expect(release).toHaveBeenCalledOnce();
    });

    it('Ошибка записи security_events откатывает квитанцию и весь пакет', async () => {
        const original = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, parameters: unknown) => {
            if (sql.startsWith('INSERT INTO security_events')) { throw new Error('Недоступна запись аудита'); }
            return original(sql, parameters);
        });
        await expect(repository.record({ events: [event] })).rejects.toThrow('Недоступна запись аудита');
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
        expect(release).toHaveBeenCalledOnce();
    });

    it('Проверяет весь пакет до обращения к пулу', async () => {
        await expect(repository.record({ events: [event, { ...event, body: 'Закрытый текст' }] })).rejects.toMatchObject({ status: 400 });
        expect(connect).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
    });

    it('Сортирует UUID перед блокировками независимо от порядка повторной доставки', async () => {
        const earlier = { ...event, id: 'a152907a-d9ab-45db-bfe1-6eac870ac624' };
        await repository.record({ events: [event, earlier] });
        const ids = query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO skill_audit_receipts')).map(([, parameters]) => parameters[0]);
        expect(ids).toEqual([earlier.id, event.id]);
    });

    it('Удаление сохраняет сводку прежней версии с источником, не придумывая новое состояние', async () => {
        await repository.record({ events: [{ ...event, action: 'skill.delete', before: state, after: null, source: 'sync' }] });
        const parameters = securityWrites()[0][1];
        expect(JSON.parse(parameters[5])).toEqual({ ...state, source: 'sync' });
        expect(JSON.parse(parameters[6])).toBeNull();
    });

    it('Пустой пакет подтверждает без открытия транзакции', async () => {
        expect(await repository.record({ events: [] })).toEqual({ accepted: 0 });
        expect(connect).not.toHaveBeenCalled();
    });

    it('Фиксирует папку той же транзакцией с UUID и источником без сводки версии файла', async () => {
        const directory = { ...event, action: 'skill.directory.create', resourceId: 'shared/team/tools', after: { directory: true } };
        expect(await repository.record({ events: [directory] })).toEqual({ accepted: 1 });
        const parameters = securityWrites()[0][1];
        expect(parameters.slice(0, 5)).toEqual([directory.id, directory.at, directory.actor, directory.action, directory.resourceId]);
        expect(JSON.parse(parameters[5])).toBeNull();
        expect(JSON.parse(parameters[6])).toEqual({ directory: true, source: 'editor' });
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
    });
});
