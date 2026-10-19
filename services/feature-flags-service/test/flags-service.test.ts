import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAGS } from '../../shared/feature-flags.cjs';
import { FlagsService } from '../src/flags/flags.service';
import { AppController } from '../src/app.controller';

const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), end: vi.fn(), options: vi.fn() }));
vi.mock('pg', () => ({ Pool: class {
    query = mocks.query; connect = mocks.connect; end = mocks.end;
    constructor(options: unknown) { mocks.options(options); }
    on() { return this; }
} }));

describe('Отказы и готовность сервиса переключателей', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT * FROM feature_flags') ? FEATURE_FLAGS.map(item => ({
            flag_key: item.key, overrides: {}, revision: 1, updated_at: '2026-10-19T00:00:00Z', updated_by: 'system:defaults',
        })) : [] }));
        mocks.connect.mockResolvedValue({ query: mocks.query, release: vi.fn() });
    });

    it('Пул ограничивает подключение, SQL и незавершённую транзакцию', () => {
        new FlagsService();
        expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ max: 3, connectionTimeoutMillis: 5000, query_timeout: 5000,
            statement_timeout: 5000, idle_in_transaction_session_timeout: 15000 }));
    });

    it('Readiness проверяет БД, liveness остаётся независимым', async () => {
        const controller = new AppController(new FlagsService());
        expect(controller.health()).toEqual({ ok: true });
        expect(await controller.ready()).toEqual({ ok: true, checks: { postgres: 'ready' } });
        mocks.query.mockRejectedValue(new Error('postgresql://user:private-password@host/catalog'));
        const failure = await controller.ready().catch(error => error);
        expect(failure.status).toBe(503); expect(failure.getResponse()).toEqual({ ok: false, checks: { postgres: 'unavailable' } });
        expect(JSON.stringify(failure.getResponse())).not.toContain('private-password');
        expect(controller.health()).toEqual({ ok: true });
    });

    it('Ошибка чтения и сохранения не раскрывает параметры PostgreSQL', async () => {
        const service = new FlagsService();
        mocks.query.mockRejectedValue(new Error('postgresql://user:private-password@host/catalog'));
        const failure = await service.list().catch(error => error);
        expect(failure.status).toBe(503); expect(failure.message).not.toContain('private-password');
        const patch = await service.patch('model_hosting', { enabled: false, expectedRevision: 1 }, async () => 'admin@example.invalid').catch(error => error);
        expect(patch.status).toBe(503); expect(patch.message).not.toContain('private-password');
    });

    it('Проверки формы и конфликты не превращаются в неопределённый отказ БД', async () => {
        const service = new FlagsService();
        await expect(service.patch('unknown', {}, async () => '')).rejects.toMatchObject({ status: 404 });
        await expect(service.patch('rag_sync', { enabled: 'false', expectedRevision: 1 }, async () => '')).rejects.toMatchObject({ status: 400 });
    });

    it('Ошибка первоначальной схемы и завершение не выдают секреты', async () => {
        const service = new FlagsService();
        mocks.connect.mockRejectedValue(new Error('private-password'));
        await expect(service.onModuleInit()).rejects.toThrow('Не удалось подготовить хранилище');
        await service.onModuleDestroy(); expect(mocks.end).toHaveBeenCalledOnce();
    });
});
