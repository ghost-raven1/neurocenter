import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { parseQuotaUsageInput } from '../quota-usage-core';
import { ProjectQuotaUsageService } from '../quota-usage.service';
import { ProjectQuotaUsageController } from '../quota-usage.controller';

describe('parseQuotaUsageInput', () => {
    const valid = { dimension: 'retention', deltaBytes: 4096, request_key: 'intent:abc' };

    it('принимает корректное тело', () => {
        expect(parseQuotaUsageInput(valid)).toEqual({ dimension: 'retention', deltaBytes: 4096, requestKey: 'intent:abc' });
    });

    it('отклоняет неизвестное измерение', () => {
        expect(() => parseQuotaUsageInput({ ...valid, dimension: 'token' })).toThrowError(/Измерение квоты/);
    });

    it('отклоняет нулевую, дробную и нечисловую дельту', () => {
        expect(() => parseQuotaUsageInput({ ...valid, deltaBytes: 0 })).toThrowError(/отличное от нуля/);
        expect(() => parseQuotaUsageInput({ ...valid, deltaBytes: 1.5 })).toThrowError(/целое число/);
        expect(() => parseQuotaUsageInput({ ...valid, deltaBytes: '4096' })).toThrowError(/целое число/);
    });

    it('отклоняет пустой ключ и ключ длиннее 512', () => {
        expect(() => parseQuotaUsageInput({ ...valid, request_key: '' })).toThrowError(/ключ повторения/);
        expect(() => parseQuotaUsageInput({ ...valid, request_key: 'k'.repeat(513) })).toThrowError(/ключ повторения/);
    });

    it('отклоняет не-объект', () => {
        expect(() => parseQuotaUsageInput(null)).toThrowError(/объектом/);
        expect(() => parseQuotaUsageInput('строка')).toThrowError(/объектом/);
        expect(() => parseQuotaUsageInput([])).toThrowError(/объектом/);
    });
});

/** Мини-ledger project_quota_usage + receipts на месте PostgreSQL. */
function ledgerFixture(projectExists = true) {
    const state = {
        projectExists,
        usage: {} as Record<string, string>,
        receipts: new Map<string, string>(),
        calls: [] as string[],
    };
    const query = async (sql: string, args: unknown[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        state.calls.push(s);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
            return { rows: [] };
        }
        if (s.startsWith('SELECT 1 FROM projects')) {
            return { rows: state.projectExists ? [{}] : [], rowCount: state.projectExists ? 1 : 0 };
        }
        if (s.startsWith('INSERT INTO project_quota_usage_requests')) {
            const [dimension, key, delta] = args as [string, string, number];
            const receiptId = `${dimension}:${key}`;
            if (state.receipts.has(receiptId)) {
                return { rows: [], rowCount: 0 };
            }
            state.receipts.set(receiptId, String(delta));
            return { rows: [], rowCount: 1 };
        }
        if (s.startsWith('SELECT used_bytes FROM project_quota_usage')) {
            const [, dimension] = args as [string, string];
            const value = state.usage[dimension];
            const rows = value === undefined ? [] : [{ used_bytes: value }];
            return { rows, rowCount: rows.length };
        }
        if (s.startsWith('INSERT INTO project_quota_usage')) {
            const [, dimension, delta] = args as [string, string, number];
            const current = state.usage[dimension] === undefined ? 0n : BigInt(state.usage[dimension]);
            const next = current + BigInt(delta);
            state.usage[dimension] = String(next < 0n ? 0n : next);
            return { rows: [] };
        }
        throw new Error('Непредвиденный SQL: ' + s);
    };
    const pool = { connect: async () => ({ query, release: vi.fn() }) };
    const service = new ProjectQuotaUsageService({ pool } as never);
    return { state, service };
}

describe('ProjectQuotaUsageService.record', () => {
    beforeEach(() => {
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('применяет дельту в транзакции и возвращает счётчик', async () => {
        const { state, service } = ledgerFixture();
        const result = await service.record('project-1', { dimension: 'retention', deltaBytes: 50, request_key: 'intent:1' });
        expect(result).toEqual({ used: 50 });
        expect(state.calls).toContain('BEGIN');
        expect(state.calls).toContain('COMMIT');
        expect(state.usage.retention).toBe('50');
    });

    it('повтор с тем же request_key идемпотентен: дельта не применяется дважды', async () => {
        const { state, service } = ledgerFixture();
        const body = { dimension: 'current', deltaBytes: 30, request_key: 'skill:x' };
        expect(await service.record('project-1', body)).toEqual({ used: 30 });
        expect(await service.record('project-1', body)).toEqual({ used: 30 });
        expect(state.usage.current).toBe('30');
        expect(state.calls.filter((call) => call === 'BEGIN')).toHaveLength(2);
        expect(state.calls.filter((call) => call === 'COMMIT')).toHaveLength(2);
    });

    it('неизвестный проект — 404 и откат транзакции', async () => {
        const { state, service } = ledgerFixture(false);
        await expect(service.record('ghost', { dimension: 'current', deltaBytes: 10, request_key: 'k' })).rejects.toThrowError(
            /Проект не найден/,
        );
        expect(state.calls).toContain('ROLLBACK');
        expect(state.calls).not.toContain('COMMIT');
    });

    it('отрицательная дельта не ниже нуля: счётчик упирается в 0 (clamp)', async () => {
        const { state, service } = ledgerFixture();
        state.usage.current = '100';
        const warn = vi.spyOn(Logger.prototype, 'warn');
        const result = await service.record('project-1', { dimension: 'current', deltaBytes: -300, request_key: 'k' });
        expect(result).toEqual({ used: 0 });
        expect(state.usage.current).toBe('0');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('уперлась в ноль');
    });

    it('битое тело — 400 до обращения к базе', async () => {
        const { state, service } = ledgerFixture();
        await expect(service.record('project-1', { dimension: 'current', deltaBytes: 0, request_key: 'k' })).rejects.toThrowError(
            /отличное от нуля/,
        );
        expect(state.calls).toEqual([]);
    });
});

describe('ProjectQuotaUsageController (internal API)', () => {
    const token = 'internal-test-token';

    beforeEach(() => {
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', token);
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    const request = (value: unknown): Request => ({ headers: { 'x-neurocenter-internal': value } }) as unknown as Request;

    it('с internal-токеном делегирует сервису (200)', async () => {
        const { service } = ledgerFixture();
        const controller = new ProjectQuotaUsageController(service);
        const result = await controller.quotaUsage(request(token), 'project-1', {
            dimension: 'staging',
            deltaBytes: 7,
            request_key: 'k',
        });
        expect(result).toEqual({ used: 7 });
    });

    it('без токена — 403', async () => {
        const { service } = ledgerFixture();
        const controller = new ProjectQuotaUsageController(service);
        await expect(controller.quotaUsage(request(undefined), 'project-1', {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('с чужим токеном — 403', async () => {
        const { service } = ledgerFixture();
        const controller = new ProjectQuotaUsageController(service);
        await expect(controller.quotaUsage(request('other'), 'project-1', {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('битое тело с токеном — 400', async () => {
        const { service } = ledgerFixture();
        const controller = new ProjectQuotaUsageController(service);
        await expect(
            controller.quotaUsage(request(token), 'project-1', { dimension: 'nope', deltaBytes: 1, request_key: 'k' }),
        ).rejects.toThrowError(/Измерение квоты/);
    });
});
