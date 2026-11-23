import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { RuntimeLimitsService } from '../runtime-limits.service';
import type { ModelsService } from '../../models/models.service';
import {
    DEFAULT_RUNTIME_LIMIT_POLICY,
    RUNTIME_LIMIT_CEILINGS,
    runtimeLimitInput,
    type IRuntimeLimitInput,
} from '../../../../shared/runtime-limits.cjs';

vi.mock('../../features/require-feature-enabled', () => ({
    requireFeatureEnabled: vi.fn(async () => undefined),
    requireFeaturesEnabled: vi.fn(async () => undefined),
}));
import { requireFeatureEnabled } from '../../features/require-feature-enabled';

const writer = 'admin@localhost';
const requestKey = '1d8fbf80-4dd6-49ac-ae54-c64ff7770990';
const updatedAt = '2026-01-02T03:04:05.000Z';
const fullPolicy = () => ({
    textKnowledge: { ...DEFAULT_RUNTIME_LIMIT_POLICY.textKnowledge },
    ggufImport: { ...DEFAULT_RUNTIME_LIMIT_POLICY.ggufImport },
});
const input = (expectedRevision: number, policy: unknown = fullPolicy()): IRuntimeLimitInput =>
    runtimeLimitInput({ expectedRevision, requestKey, policy });
const fingerprint = (value: { writer: string } & IRuntimeLimitInput) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
const req = () => ({ headers: {} }) as Request;
const validActor = { enabled: true, is_main_admin: true };

/** Мини runtime_limit_settings + receipts + platform_users на месте PostgreSQL. */
function limitsFixture(opts: {
    settings?: { revision: number; policy: unknown } | null;
    user?: { enabled: boolean; is_main_admin: boolean };
    receipt?: { requestKey: string; requestHash: string; result: unknown } | null;
    failQuery?: string | null;
}) {
    const state = {
        settings: opts.settings === undefined ? null : opts.settings,
        user: opts.user ?? validActor,
        receipt: opts.receipt ?? null,
        failQuery: opts.failQuery ?? null,
        calls: [] as string[],
        securityEvents: [] as unknown[],
        requests: [] as unknown[],
        committed: 0,
        rolledBack: 0,
    };
    const query = async (sql: string, args: unknown[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        state.calls.push(s);
        if (state.failQuery === s) throw new Error('DB-недоступность в ' + s);
        if (s === 'BEGIN') return { rows: [] };
        if (s === 'COMMIT') {
            state.committed += 1;
            return { rows: [] };
        }
        if (s === 'ROLLBACK') {
            state.rolledBack += 1;
            return { rows: [] };
        }
        if (s.startsWith('SET LOCAL') || s.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
        if (s.startsWith('SELECT enabled,is_main_admin FROM platform_users'))
            return { rows: [state.user], rowCount: 1 };
        if (s.startsWith('SELECT request_hash,result FROM runtime_limit_requests'))
            return {
                rows: state.receipt ? [{ request_hash: state.receipt.requestHash, result: state.receipt.result }] : [],
            };
        if (s.startsWith('SELECT result FROM runtime_limit_requests'))
            return { rows: state.receipt ? [{ result: state.receipt.result }] : [] };
        if (s.startsWith('SELECT revision,policy,updated_at FROM runtime_limit_settings'))
            return {
                rows: state.settings
                    ? [{ revision: state.settings.revision, policy: state.settings.policy, updated_at: updatedAt }]
                    : [],
            };
        if (s.startsWith('INSERT INTO runtime_limit_settings')) {
            const revision = (state.settings?.revision ?? 0) + 1;
            state.settings = { revision, policy: JSON.parse(args[0] as string) };
            return { rows: [{ revision, updated_at: new Date(updatedAt) }], rowCount: 1 };
        }
        if (s.startsWith('INSERT INTO security_events')) {
            state.securityEvents.push({ args });
            return { rows: [] };
        }
        if (s.startsWith('INSERT INTO runtime_limit_requests')) {
            state.requests.push({ args });
            return { rows: [] };
        }
        throw new Error('Непредвиденный SQL: ' + s);
    };
    const pool = { query, connect: async () => ({ query, release: vi.fn() }) };
    const models = {
        pool,
        actor: vi.fn(async () => ({ email: writer, activeRole: 'Главный админ' })),
        requireMain: vi.fn(async () => writer),
    };
    const service = new RuntimeLimitsService(models as unknown as ModelsService);
    return { state, service, models };
}

describe('RuntimeLimitsService.effective', () => {
    it('без строки — дефолтная политика, ревизия 0', async () => {
        const { service } = limitsFixture({});
        const view = await service.effective();
        expect(view.revision).toBe(0);
        expect(view.policy.textKnowledge).toEqual(DEFAULT_RUNTIME_LIMIT_POLICY.textKnowledge);
        expect(view.policy.ggufImport).toEqual(DEFAULT_RUNTIME_LIMIT_POLICY.ggufImport);
        expect(view.updatedAt).toBeNull();
        expect(view.ceilings).toBe(RUNTIME_LIMIT_CEILINGS);
    });

    it('со строкой — сохранённая политика и ревизия', async () => {
        const { service } = limitsFixture({ settings: { revision: 4, policy: fullPolicy() } });
        const view = await service.effective();
        expect(view.revision).toBe(4);
        expect(view.policy.ggufImport.maximumBytes).toBe(
            DEFAULT_RUNTIME_LIMIT_POLICY.ggufImport.maximumBytes,
        );
        expect(view.updatedAt).toBe(updatedAt);
    });

    it('повреждённая политика в строке — 503, не 500 и не сообщение валидатора', async () => {
        const { service } = limitsFixture({ settings: { revision: 1, policy: { textKnowledge: { bogus: 1 } } } });
        const error: unknown = await service.effective().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect((error as ServiceUnavailableException).getStatus()).toBe(503);
        expect(String((error as ServiceUnavailableException).getResponse().message)).toContain(
            'Действующие лимиты не подтверждены',
        );
    });

    it('ggufPolicy() — только gguf-секция действующей политики', async () => {
        const { service } = limitsFixture({});
        expect(await service.ggufPolicy()).toEqual(DEFAULT_RUNTIME_LIMIT_POLICY.ggufImport);
    });
});

describe('RuntimeLimitsService.save', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it('сохраняет политику: ревизия++, security-событие, квитанция, COMMIT', async () => {
        const { state, service } = limitsFixture({});
        const result = await service.save(req(), input(0));
        expect(result.revision).toBe(1);
        expect(result.requestKey).toBe(requestKey);
        expect(result.requestHash).toBe(fingerprint({ writer, ...input(0) }));
        expect(result.policy).toEqual(fullPolicy());
        expect(result.acceptedAt).toBe(updatedAt);
        expect(state.committed).toBe(1);
        expect(state.rolledBack).toBe(0);
        expect(state.securityEvents).toHaveLength(1);
        const eventArgs = state.securityEvents[0].args as unknown[];
        expect(eventArgs[2]).toBe('runtime.limits.update');
        expect(eventArgs[3]).toBe('runtime-limits');
        const before = JSON.parse(String(eventArgs[4]));
        const after = JSON.parse(String(eventArgs[5]));
        expect(before).toMatchObject({ revision: 0 });
        expect(after).toMatchObject({ revision: 1 });
        expect(state.requests).toHaveLength(1);
        expect(requireFeatureEnabled).toHaveBeenCalledWith('runtime_limit_configuration');
    });

    it('конфликт ревизии — 409 и откат, без security-события', async () => {
        const { state, service } = limitsFixture({ settings: { revision: 5, policy: fullPolicy() } });
        await expect(service.save(req(), input(4))).rejects.toThrowError('Лимиты уже изменились');
        expect(state.rolledBack).toBe(1);
        expect(state.committed).toBe(0);
        expect(state.securityEvents).toHaveLength(0);
    });

    it('повтор с тем же ключом и хэшем идемпотентен: та же квитанция', async () => {
        const first = {
            requestKey,
            requestHash: fingerprint({ writer, ...input(0) }),
            revision: 1,
            policy: fullPolicy(),
            acceptedAt: updatedAt,
        };
        const { state, service } = limitsFixture({
            receipt: { requestKey, requestHash: first.requestHash, result: first },
        });
        const result = await service.save(req(), input(0));
        expect(result).toEqual(first);
        expect(state.securityEvents).toHaveLength(0);
        expect(state.requests).toHaveLength(0);
    });

    it('тот же ключ с другим хэшем — 409', async () => {
        const { service } = limitsFixture({
            receipt: { requestKey, requestHash: '0'.repeat(64), result: { revision: 1 } },
        });
        await expect(service.save(req(), input(0))).rejects.toThrowError('Ключ уже относится к другим лимитам');
    });

    it('политика выше ceiling — 400 на валидации, до SQL', async () => {
        const { state, service } = limitsFixture({});
        const policy = fullPolicy();
        (policy.ggufImport as { maximumBytes: number }).maximumBytes =
            RUNTIME_LIMIT_CEILINGS.ggufImport.maximumBytes + 1;
        const error: unknown = await service
            .save(req(), { expectedRevision: 0, requestKey, policy })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(String((error as BadRequestException).message)).toContain(
            `GGUF maximumBytes: максимум ${RUNTIME_LIMIT_CEILINGS.ggufImport.maximumBytes}`,
        );
        expect(state.calls).toHaveLength(0);
    });

    it('неполная политика — 400 на валидации', async () => {
        const { state, service } = limitsFixture({});
        const error: unknown = await service
            .save(req(), { expectedRevision: 0, requestKey, policy: { textKnowledge: fullPolicy().textKnowledge } })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(String((error as BadRequestException).message)).toContain('Нужны полные группы лимитов текста и GGUF');
        expect(state.calls).toHaveLength(0);
    });

    it('права отозваны в транзакции — 403 и откат', async () => {
        const { state, service } = limitsFixture({ user: { enabled: true, is_main_admin: false } });
        await expect(service.save(req(), input(0))).rejects.toThrowError('Права главного администратора отозваны');
        expect(state.rolledBack).toBe(1);
        expect(state.securityEvents).toHaveLength(0);
    });

    it('DB-недоступность — ROLLBACK и 503 RUNTIME_LIMIT_SAVE_UNCONFIRMED', async () => {
        const { state, service } = limitsFixture({
            failQuery: 'SELECT revision,policy,updated_at FROM runtime_limit_settings WHERE singleton',
        });
        const error: unknown = await service.save(req(), input(0)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect((error as ServiceUnavailableException).getStatus()).toBe(503);
        expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
            code: 'RUNTIME_LIMIT_SAVE_UNCONFIRMED',
        });
        expect(state.rolledBack).toBe(1);
        expect(state.committed).toBe(0);
        expect(state.securityEvents).toHaveLength(0);
    });

    it('заголовок authorization — 403: лимиты меняет только главный администратор', async () => {
        const { state, service } = limitsFixture({});
        const error: unknown = await service
            .save({ headers: { authorization: 'Bearer x' } } as Request, input(0))
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(state.calls).toHaveLength(0);
    });
});

describe('RuntimeLimitsService.receipt', () => {
    it('ключ без UUID — 400', async () => {
        const { service } = limitsFixture({});
        await expect(service.receipt(req(), 'not-a-uuid')).rejects.toThrowError('Нужен ключ сохранения лимитов');
    });

    it('квитанция не найдена — 404', async () => {
        const { service } = limitsFixture({});
        await expect(service.receipt(req(), requestKey)).rejects.toThrowError(
            'Квитанция этого сохранения не найдена',
        );
    });

    it('квитанция найдена — возвращает сохранённый результат', async () => {
        const result = { revision: 2, requestKey };
        const { service } = limitsFixture({
            receipt: { requestKey, requestHash: 'f'.repeat(64), result },
        });
        expect(await service.receipt(req(), requestKey)).toEqual(result);
    });
});
