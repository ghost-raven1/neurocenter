import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { DeviceStore } from '../device-store';
import type { IAccessActor } from '../../access/access.model';

const actor: IAccessActor = { email: 'owner@local', activeRole: 'Главный админ' };
const deviceId = '11111111-1111-4111-8111-111111111111';
const jobRow = {
    id: '33333333-3333-4333-8333-333333333333',
    device_id: deviceId,
    email: 'owner@local',
    role: 'Главный админ',
    project_id: 'p-1',
    kind: 'install',
    state: 'running',
    percent: 45,
    lease_until: new Date(Date.now() + 60_000),
    result: null,
    payload: { package: { plugin: { id: 'asset-1', kind: 'mcp', version: 7 }, manifest: { sha256: 'a'.repeat(64) } } },
};
const deviceRow = { id: deviceId, email: 'owner@local', role: 'Главный админ', name: 'dev', fingerprint: 'b'.repeat(64), last_seen: null, report: null, revoked: false };

/** Фейк пула: перехватывает транзакцию revoke/approve и возвращает нужные строки. */
function fakePool() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const handle = async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.startsWith('SELECT id,email,role,name,fingerprint')) return { rows: [deviceRow] };
        if (sql.startsWith('UPDATE bridge_jobs')) return { rows: [jobRow] };
        if (sql.startsWith('UPDATE bridge_pairs')) return { rows: [], rowCount: 1 };
        if (sql.startsWith('SELECT user_code AS')) return { rows: [{ userCode: 'A1B2C3D4', name: 'dev', fingerprint: 'b'.repeat(64), expiresAt: null, approved: false }] };
        return { rows: [], rowCount: 0 };
    };
    const client = { query: handle, release: () => undefined };
    const pool = { query: handle, connect: async () => client } as unknown as Pool;
    return { pool, calls };
}

function storeWith(pool: Pool): DeviceStore {
    const access = { claims: async () => ({ userRoles: ['Главный админ'] }) };
    const store = new DeviceStore(access as never);
    (store as unknown as { pool: Pool }).pool = pool;
    return store;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('FR-903/AD-O7: device.revoke и device.pair — security-события атомарно с мутацией', () => {
    it('revoke: security_event device.revoke в той же транзакции, что и отзыв', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        const { pool, calls } = fakePool();
        const store = storeWith(pool);
        const result = await store.revoke(actor, deviceId);
        expect(result).toEqual({ ok: true });

        const begin = calls.findIndex((c) => c.sql === 'BEGIN');
        const commit = calls.findIndex((c) => c.sql === 'COMMIT');
        const rollback = calls.findIndex((c) => c.sql === 'ROLLBACK');
        expect(begin).toBeGreaterThanOrEqual(0);
        expect(commit).toBeGreaterThan(begin);
        expect(rollback).toBe(-1);

        const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO security_events'));
        expect(inserts).toHaveLength(1);
        const [eventId, evActor, action, resourceId, before, after] = inserts[0]!.params as unknown[];
        expect(typeof eventId).toBe('string');
        expect(evActor).toBe('owner@local');
        expect(action).toBe('device.revoke');
        expect(resourceId).toBe(deviceId);
        expect(JSON.parse(String(before))).toEqual({ deviceId, email: 'owner@local', revoked: false });
        expect(JSON.parse(String(after))).toEqual({ deviceId, email: 'owner@local', revoked: true });
        // атомарность: событие между BEGIN и COMMIT (тот же транзакционный клиент)
        const insertIdx = calls.findIndex((c) => c === inserts[0]!);
        expect(insertIdx).toBeGreaterThan(begin);
        expect(insertIdx).toBeLessThan(commit);

        // отзыв рабочих jobs остаётся записанным в operations (не дублируется в security_events)
        const opInserts = calls.filter((c) => c.sql.startsWith('INSERT INTO operations'));
        expect(opInserts).toHaveLength(1);
    });

    it('approve: security_event device.pair в транзакции; resourceId — digest кода (AD-O8)', async () => {
        const userCode = 'A1B2C3D4';
        const { pool, calls } = fakePool();
        const store = storeWith(pool);
        const result = await store.approve(actor, userCode);
        expect(result).toEqual({ ok: true });

        const begin = calls.findIndex((c) => c.sql === 'BEGIN');
        const commit = calls.findIndex((c) => c.sql === 'COMMIT');
        expect(begin).toBeGreaterThanOrEqual(0);
        expect(commit).toBeGreaterThan(begin);

        const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO security_events'));
        expect(inserts).toHaveLength(1);
        const [, evActor, action, resourceId, , after] = inserts[0]!.params as unknown[];
        expect(evActor).toBe('owner@local');
        expect(action).toBe('device.pair');
        // сам код привязки (credential-like) в событие не идёт — только sha256
        expect(resourceId).toBe(createHash('sha256').update(userCode).digest('hex'));
        expect(JSON.parse(String(after))).toEqual({ email: 'owner@local', role: 'Главный админ' });
        const insertIdx = calls.findIndex((c) => c === inserts[0]!);
        expect(insertIdx).toBeGreaterThan(begin);
        expect(insertIdx).toBeLessThan(commit);
    });
});
