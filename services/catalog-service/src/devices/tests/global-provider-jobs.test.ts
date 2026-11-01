import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { ForbiddenException } from '@nestjs/common';
import {
    OPENCODE_GLOBAL_PROVIDERS_CAPABILITY as legacyCapability,
    OPENCODE_V2_ACCOUNTS_ADAPTER as adapter,
    OPENCODE_V2_ACCOUNTS_CAPABILITY as capability,
    OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB as open,
    OPENCODE_GLOBAL_PROVIDERS_READ_JOB as read,
} from '../../../../shared/opencode-local-providers.cjs';
import {
    authorizeGlobalProvidersSession,
    completeGlobalProviders,
    globalProvidersJobPayload,
} from '../global-provider-jobs';
import type { IDevice } from '../device-store';

const deviceId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const device = {
    id: deviceId,
    email: 'owner@example.test',
    role: 'Главный админ',
    report: { capabilities: [capability] },
} as unknown as IDevice;
const payload = { schemaVersion: 1, scope: 'global', deviceId, adapter, expiresAt: '2099-01-01T00:00:00.000Z' };
const job = {
    id,
    device_id: deviceId,
    email: device.email,
    role: device.role,
    project_id: null,
    kind: open,
    payload,
    state: 'running',
    result: {},
};
function database(authorized = true) {
    const query = vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT * FROM bridge_jobs')) return { rows: [job] };
        if (sql.startsWith('SELECT * FROM bridge_devices')) return { rows: [device] };
        if (sql.startsWith('SELECT enabled,is_main_admin')) return { rows: [{ enabled: true, is_main_admin: true }] };
        if (sql.includes('AS authorized')) return { rows: [{ authorized }] };
        return { rows: [] };
    });
    return { query, db: { query } as unknown as Pick<PoolClient, 'query'> };
}

describe('V2 account job boundaries', () => {
    it('requires the exact capability and retains adapter identity in the admitted job', () => {
        const input = { deviceId, kind: read, scope: 'global' as const, requestKey: id, adapter };
        expect(globalProvidersJobPayload(device, input, device.role)).toEqual({
            schemaVersion: 1,
            scope: 'global',
            deviceId,
            adapter,
        });
        const legacy = { ...device, report: { ...device.report, capabilities: [legacyCapability] } };
        expect(() => globalProvidersJobPayload(legacy, input, device.role)).toThrow();
        const { adapter: _adapter, ...oldInput } = input;
        expect(globalProvidersJobPayload(legacy, oldInput, device.role)).not.toHaveProperty('adapter');
    });
    it('requires V2 feature authority from the saved payload for every private session permit', async () => {
        const { db, query } = database();
        const enabled = vi.fn(async () => {
            throw new ForbiddenException('Feature disabled');
        });
        await expect(
            authorizeGlobalProvidersSession({ pool: db }, device, { jobId: id }, enabled, 'a'.repeat(64)),
        ).rejects.toThrow('Feature disabled');
        expect(enabled).toHaveBeenCalledWith(payload);
        expect(query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
        expect(query.mock.calls.some(([sql]) => sql.includes('AS authorized'))).toBe(false);
    });
    it('does not grant a session after fresh access has been revoked', async () => {
        const { db } = database(false);
        await expect(
            authorizeGlobalProvidersSession({ pool: db }, device, { jobId: id }, async () => {}, 'a'.repeat(64)),
        ).rejects.toThrow('отозван');
    });
    it('uses the V2 capability in the final atomic permission check', async () => {
        const { db, query } = database();
        await expect(
            authorizeGlobalProvidersSession({ pool: db }, device, { jobId: id }, async () => {}, 'a'.repeat(64)),
        ).resolves.toEqual({ ok: true, expiresAt: payload.expiresAt });
        const finalCall = query.mock.calls.find(([sql]) => sql.includes('AS authorized')) as unknown as [
            string,
            unknown[],
        ];
        expect(finalCall[1][6]).toBe(capability);
    });
    it.each([undefined, 'wrong-mode'])(
        'rejects completion from another adapter before storing it: %s',
        async (otherAdapter) => {
            const { db, query } = database();
            const result = {
                schemaVersion: 1,
                scope: 'global',
                deviceId,
                jobId: id,
                kind: open,
                checkedAt: '2026-11-01T00:00:00.000Z',
                status: 'opened',
                expiresAt: payload.expiresAt,
                ...(otherAdapter ? { adapter: otherAdapter } : {}),
            };
            await expect(completeGlobalProviders(db, job, { state: 'succeeded', result } as never)).rejects.toThrow(
                'Квитанция',
            );
            expect(query).not.toHaveBeenCalled();
        },
    );
    it('accepts only account metadata and ignores transport message content when recording completion', async () => {
        const { db, query } = database();
        const result = {
            schemaVersion: 1,
            scope: 'global',
            deviceId,
            jobId: id,
            kind: read,
            adapter,
            checkedAt: '2026-11-01T00:00:00.000Z',
            status: 'checked',
            accountInventory: {
                accounts: [{ integrationId: 'anthropic', hasApiKey: true, hasOAuth: false, hasExternal: false }],
                issues: [],
            },
        };
        const { expiresAt: _expiresAt, ...readPayload } = payload;
        await expect(
            completeGlobalProviders(db, { ...job, kind: read, payload: readPayload }, {
                state: 'succeeded',
                result,
                message: 'synthetic-secret',
            } as never),
        ).resolves.toEqual({ ok: true, repeated: false });
        expect(JSON.stringify(query.mock.calls)).not.toContain('synthetic-secret');
    });
    it('rejects credentials accidentally included in the public completion', async () => {
        const { db, query } = database();
        const result = {
            schemaVersion: 1,
            scope: 'global',
            deviceId,
            jobId: id,
            kind: read,
            adapter,
            checkedAt: '2026-11-01T00:00:00.000Z',
            status: 'checked',
            accountInventory: {
                accounts: [
                    {
                        integrationId: 'anthropic',
                        hasApiKey: true,
                        hasOAuth: false,
                        hasExternal: false,
                        value: { key: 'synthetic-secret' },
                    },
                ],
                issues: [],
            },
        };
        const { expiresAt: _expiresAt, ...readPayload } = payload;
        await expect(
            completeGlobalProviders(db, { ...job, kind: read, payload: readPayload }, {
                state: 'succeeded',
                result,
            } as never),
        ).rejects.toThrow('Квитанция');
        expect(query).not.toHaveBeenCalled();
    });
});
