import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeDeviceJob } from '../device-completion';

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
    payload: {
        package: {
            plugin: { id: 'asset-1', kind: 'mcp', version: 7 },
            manifest: { sha256: 'a'.repeat(64) },
        },
    },
};
const integrity = { expected: 'b'.repeat(64), computed: 'c'.repeat(64) };

/** Фейк пула покрывает полный путь install-завершения: BEGIN → лок-ы → SELECT job → ... → UPDATE → COMMIT. */
function fakePool(job: Record<string, unknown>) {
    const calls: { statements: string[]; params: Array<unknown[]> } = { statements: [], params: [] };
    const handle = async (sql: string, params: unknown[] = []) => {
        calls.statements.push(sql);
        calls.params.push(params);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.startsWith('SELECT * FROM bridge_jobs')) return { rows: [job] };
        return { rows: [] };
    };
    const client = { query: handle, release: () => undefined };
    const pool = { query: handle, connect: async () => client } as unknown as Pool;
    return { pool, calls };
}

function failedInput(result: Record<string, unknown>) {
    return {
        lease: '44444444-4444-4444-8444-444444444444',
        state: 'failed' as const,
        message: 'Готовый комплект не совпал с одобренной контрольной суммой. Установка не выполнена; файлы проекта не изменены.',
        result: {
            projectId: 'p-1',
            assetId: 'asset-1',
            version: 7,
            manifest: 'a'.repeat(64),
            unchanged: true,
            ...result,
        },
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('completeDeviceJob — AD-D5 security event при SHA-mismatch комплекта (OQ-4)', () => {
    it('failed install с artifactIntegrity → event installation.artifact.integrity атомарно с результатом', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        const { pool, calls } = fakePool(jobRow);
        const result = await completeDeviceJob(pool, deviceId, jobRow.id, failedInput({ artifactIntegrity: integrity }));
        expect(result).toEqual({ ok: true, repeated: false });
        const inserts = calls.statements
            .map((sql, i) => ({ sql, params: calls.params[i] }))
            .filter(({ sql }) => sql.startsWith('INSERT INTO security_events'));
        expect(inserts).toHaveLength(1);
        const [eventId, actor, action, resourceId, before, after] = inserts[0]!.params as unknown[];
        expect(typeof eventId).toBe('string');
        expect(actor).toBe(deviceId);
        expect(action).toBe('installation.artifact.integrity');
        expect(resourceId).toBe(jobRow.id);
        expect(JSON.parse(String(before))).toEqual({
            assetId: 'asset-1',
            version: 7,
            manifest: 'a'.repeat(64),
            expected: integrity.expected,
        });
        expect(JSON.parse(String(after))).toEqual({ state: 'failed', computed: integrity.computed });
        // Event внутри той же транзакции, что и UPDATE задания.
        expect(calls.statements.indexOf(inserts[0]!.sql)).toBeLessThan(
            calls.statements.findIndex((sql) => sql.startsWith('UPDATE bridge_jobs')),
        );
        expect(calls.statements).toContain('COMMIT');
    });
    it('Повторный ACK уже failed задания не пишет второй event', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        const input = failedInput({ artifactIntegrity: integrity });
        const { pool, calls } = fakePool({ ...jobRow, state: 'failed', result: input.result });
        const result = await completeDeviceJob(pool, deviceId, jobRow.id, input);
        expect(result).toEqual({ ok: true, repeated: true });
        expect(calls.statements.some((sql) => sql.startsWith('INSERT INTO security_events'))).toBe(false);
    });
    it('Повреждённый artifactIntegrity → отказ до фиксации результата', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        const { pool, calls } = fakePool(jobRow);
        await expect(
            completeDeviceJob(pool, deviceId, jobRow.id, failedInput({ artifactIntegrity: { expected: 'b'.repeat(64), computed: 'nope' } })),
        ).rejects.toThrow();
        expect(calls.statements.some((sql) => sql.startsWith('INSERT INTO security_events'))).toBe(false);
        expect(calls.statements.some((sql) => sql.startsWith('UPDATE bridge_jobs'))).toBe(false);
        expect(calls.statements).toContain('ROLLBACK');
    });
    it('succeeded install не пишет integrity-event', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        const { pool, calls } = fakePool(jobRow);
        const input = {
            lease: '44444444-4444-4444-8444-444444444444',
            state: 'succeeded' as const,
            message: 'Файлы установлены',
            result: {
                projectId: 'p-1',
                assetId: 'asset-1',
                version: 7,
                manifest: 'a'.repeat(64),
                unchanged: false,
                artifactIntegrity: integrity,
            },
        };
        await completeDeviceJob(pool, deviceId, jobRow.id, input);
        expect(calls.statements.some((sql) => sql.startsWith('INSERT INTO security_events'))).toBe(false);
        expect(calls.statements).toContain('COMMIT');
    });
    it('Не install-задание с тем же полем не пишет event', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        const { pool, calls } = fakePool({ ...jobRow, kind: 'choose-root', project_id: null, payload: {} });
        const input = {
            lease: '44444444-4444-4444-8444-444444444444',
            state: 'failed' as const,
            message: 'Действие не выполнено.',
            result: { artifactIntegrity: integrity },
        };
        await completeDeviceJob(pool, deviceId, jobRow.id, input);
        expect(calls.statements.some((sql) => sql.startsWith('INSERT INTO security_events'))).toBe(false);
        expect(calls.statements).toContain('COMMIT');
    });
});
