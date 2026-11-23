import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ErrorEventsService } from '../error-events.service';
import { ErrorEventsController, ErrorEventsInternalController } from '../error-events.controller';

/**
 * AD-O5 (res-obs 6.10): error-store — приём пакетов из outbox (1..200, tx,
 * валидация safe-полей) и чтение для Главного админа (GET /api/errors).
 */

/** Fake pg pool: фиксирует SQL/параметры, отвечает на count/rows. */
function fakePool(rows: Array<Record<string, unknown>> = [], total = 0) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
        query: async (sql: string, params: unknown[] = []) => {
            calls.push({ sql, params });
            if (sql.startsWith('SELECT count(*)')) return { rows: [{ n: total }] };
            return { rows };
        },
        connect: async () => client,
        release: () => undefined,
    };
    const pool = client as unknown as Pool;
    return { pool, calls, client };
}

function serviceWith(pool: Pool): ErrorEventsService {
    const service = new ErrorEventsService();
    (service as unknown as { pool: Pool }).pool = pool;
    return service;
}

const baseEvent = {
    service: 'api-gateway',
    level: 'error' as const,
    message: 'explicit.report',
};

describe('ErrorEventsService.record: пакет 1..200 в одной транзакции', () => {
    it('валидный пакет — BEGIN/insert.../COMMIT, ответ {received}', async () => {
        const { pool, calls } = fakePool();
        const service = serviceWith(pool);
        const result = await service.record([
            { ...baseEvent, id: 'aabbccdd-1111-2222-3333-444455556666', requestId: 'req-1', stackHint: 'hint' },
            { ...baseEvent, level: 'critical', message: 'crash.uncaughtException' },
        ]);
        expect(result).toEqual({ received: 2 });
        const sqls = calls.map((call) => call.sql);
        expect(sqls[0]).toBe('BEGIN');
        expect(sqls.filter((sql) => sql.startsWith('INSERT INTO error_events'))).toHaveLength(2);
        expect(sqls[sqls.length - 1]).toBe('COMMIT');
        const insert = calls.find((call) => call.sql.startsWith('INSERT INTO error_events'));
        expect(insert.params[0]).toBe('aabbccdd-1111-2222-3333-444455556666');
        expect(insert.params[3]).toBe('req-1');
    });

    it('пустой пакет, >200 и некорректные поля отклоняются до SQL', async () => {
        const { pool, calls } = fakePool();
        const service = serviceWith(pool);
        await expect(service.record([])).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.record(Array.from({ length: 201 }, () => baseEvent))).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.record([{ ...baseEvent, level: 'warning' } as never])).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.record([{ level: 'error', message: 'm' } as never])).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.record([{ ...baseEvent, service: '' }])).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.record([{ ...baseEvent, id: 42 } as never])).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.record([{ ...baseEvent, requestId: 7 } as never])).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.record([{ ...baseEvent, stackHint: 'x'.repeat(4097) }])).rejects.toBeInstanceOf(BadRequestException);
        expect(calls).toHaveLength(0);
    });

    it('ошибка INSERT после BEGIN — ROLLBACK, без COMMIT', async () => {
        const calls: Array<{ sql: string; params: unknown[] }> = [];
        const client = {
            query: async (sql: string, params: unknown[] = []) => {
                calls.push({ sql, params });
                if (sql.startsWith('INSERT INTO error_events')) throw new Error('pg down (simulated)');
                return { rows: [] };
            },
            connect: async () => client,
            release: () => undefined,
        };
        const service = serviceWith(client as unknown as Pool);
        await expect(service.record([baseEvent, { ...baseEvent, level: 'critical' }])).rejects.toThrow('pg down');
        const sqls = calls.map((call) => call.sql);
        expect(sqls[0]).toBe('BEGIN');
        expect(sqls[sqls.length - 1]).toBe('ROLLBACK');
        expect(sqls).not.toContain('COMMIT');
    });
});

describe('ErrorEventsService.list: фильтры и пагинация', () => {
    it('передаёт service/requestId/level/since и страницу', async () => {
        const { pool, calls } = fakePool(
            [
                {
                    id: 'e-1',
                    service: 'api-gateway',
                    ts: '2026-11-23T00:00:00Z',
                    level: 'error',
                    requestId: null,
                    message: 'crash.uncaughtException',
                    stackHint: null,
                },
            ],
            1,
        );
        const service = serviceWith(pool);
        const since = new Date('2026-11-01T00:00:00Z');
        const page = await service.list({ service: 'api-gateway', requestId: 'req-9', level: 'critical', since, page: 2, size: 5 });
        expect(page.total).toBe(1);
        expect(page.page).toBe(2);
        expect(page.items[0].message).toBe('crash.uncaughtException');
        const listCall = calls.find((call) => call.sql.startsWith('SELECT id,service,ts'));
        expect(listCall.sql).toContain('WHERE service = $1 AND request_id = $2 AND level = $3 AND ts >= $4');
        expect(listCall.sql).toContain('ORDER BY ts DESC, id DESC');
        expect(listCall.params).toEqual(['api-gateway', 'req-9', 'critical', since, 5, 5]);
    });
});

describe('ErrorEventsController (GET /api/errors): доступ только Главному админу', () => {
    const list = vi.fn(() => Promise.resolve({ items: [], page: 1, size: 20, total: 0 }));
    const controller = new ErrorEventsController({ list } as never);
    const actor = (activeRole: string) => ({
        headers: { 'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: 'admin@local', activeRole })) },
    });

    it('роль «Главный админ» — запрос к хранилищу с фильтрами', async () => {
        const result = await controller.listErrors(actor('Главный админ') as never, {
            service: 'api-gateway',
            period: '24h',
            page: '2',
            size: '10',
        });
        expect(list).toHaveBeenCalledTimes(1);
        const query = list.mock.calls[0][0];
        expect(query.service).toBe('api-gateway');
        expect(query.page).toBe(2);
        expect(query.size).toBe(10);
        expect(query.since).toBeInstanceOf(Date);
        const age = Date.now() - query.since.getTime();
        expect(age).toBeGreaterThan(24 * 3600 * 1000 - 5000);
        expect(age).toBeLessThanOrEqual(24 * 3600 * 1000 + 5000);
        expect(result.total).toBe(0);
    });

    it('период d: 7d → 7 суток', async () => {
        await controller.listErrors(actor('Главный админ') as never, { period: '7d' });
        const query = list.mock.calls.at(-1)![0];
        const age = Date.now() - query.since.getTime();
        expect(age).toBeGreaterThan(7 * 86400 * 1000 - 5000);
        expect(age).toBeLessThanOrEqual(7 * 86400 * 1000 + 5000);
    });

    it('неродной админ — Forbidden; некорректный период/уровень — BadRequest', async () => {
        await expect(controller.listErrors(actor('Разработчик') as never, {})).rejects.toBeInstanceOf(ForbiddenException);
        await expect(controller.listErrors(actor('Главный админ') as never, { period: '7w' })).rejects.toBeInstanceOf(
            BadRequestException,
        );
        await expect(controller.listErrors(actor('Главный админ') as never, { level: 'warning' })).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });
});

describe('ErrorEventsInternalController (POST /internal/error-events)', () => {
    it('assertInternal + record', async () => {
        const previous = process.env.NEUROCENTER_INTERNAL_TOKEN;
        process.env.NEUROCENTER_INTERNAL_TOKEN = 'test-token';
        try {
            const record = vi.fn(() => Promise.resolve({ received: 1 }));
            const controller = new ErrorEventsInternalController({ record } as never);
            await expect(
                controller.record('wrong', { events: [baseEvent] }),
            ).rejects.toBeInstanceOf(ForbiddenException);
            const result = await controller.record('test-token', { events: [baseEvent] });
            expect(result).toEqual({ received: 1 });
            expect(record).toHaveBeenCalledWith([baseEvent]);
        } finally {
            process.env.NEUROCENTER_INTERNAL_TOKEN = previous;
        }
    });
});
