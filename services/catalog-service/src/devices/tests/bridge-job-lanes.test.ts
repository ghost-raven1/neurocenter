import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DeviceJobs } from '../device-jobs';
import type { IDevice } from '../device-store';
import { FEATURE_FLAG_KEYS } from '../../../../shared/feature-flags.cjs';

const deviceId = '11111111-1111-4111-8111-111111111111';
const email = 'admin@local';
const device = {
    id: deviceId,
    email,
    role: 'Главный админ',
    report: {
        protocolVersion: 2,
        // workspace-instance-v1 обязателен для scan-opencode-models: post-claim
        // assertProjectLocalJob → assertLocalFeature → assertWorkspaceCapability.
        capabilities: [
            'durable-completions',
            'managed-installations',
            'opencode-model-scan-v2',
            'workspace-instance-v1',
        ],
        bindings: [],
    },
} as unknown as IDevice;

const job = (id: string, kind: string, payload: Record<string, unknown>) => ({
    id,
    device_id: deviceId,
    email,
    role: 'Главный админ',
    project_id: null,
    kind,
    payload,
    state: 'queued',
    percent: 0,
    message: '',
    result: null,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
});

const readJob = () =>
    job('33333333-3333-4333-8333-333333333333', 'scan-opencode-models', { scope: 'global', deviceId });
const writeJob = () => job('44444444-4444-4444-8444-444444444444', 'choose-root', {});

interface IEnv {
    /** Активная RUNNING-запись с живым лизом (офф-ветка claim). */
    active: boolean;
    /** Очередь в порядке created_at (как вернул бы ORDER BY PG). */
    queued: Array<ReturnType<typeof readJob> | ReturnType<typeof writeJob>>;
    lanes: { readRunning: number; writeRunning: number };
}

interface ICalls {
    statements: string[];
    claims: Array<{ id: string; lease: string }>;
    laneCountQueries: number;
}

/**
 * Фейк пула покрывает весь путь claim: expire (reconcile + переходы через
 * pool.connect), транзакцию выдачи (bridge_devices, активные/очередь,
 * lane-счётчики, UPDATE выдачи, operations) и post-commit проверки.
 */
function fakePool(env: IEnv): { pool: Pool; calls: ICalls } {
    const calls: ICalls = { statements: [], claims: [], laneCountQueries: 0 };
    const handle = async (sql: string, params: unknown[] = []) => {
        calls.statements.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FROM bridge_devices'))
            return { rows: [{ id: deviceId, paused: false, report_unavailable: false }] };
        if (sql.startsWith('SELECT 1 FROM bridge_jobs')) return { rows: env.active ? [{ 1: 1 }] : [] };
        if (sql.includes("state='queued'")) return { rows: env.queued };
        if (sql.includes('count(*) FILTER')) {
            calls.laneCountQueries += 1;
            return { rows: [env.lanes] };
        }
        if (sql.startsWith("UPDATE bridge_jobs SET state='running'")) {
            calls.claims.push({ id: params[0] as string, lease: params[1] as string });
            return { rows: [] };
        }
        if (sql.startsWith('UPDATE bridge_jobs')) return { rows: [] };
        if (sql.startsWith('INSERT INTO operations')) return { rows: [] };
        if (sql.includes('current_setting') || sql.includes('set_config')) return { rows: [] };
        return { rows: [] };
    };
    const client = { query: handle, release: () => undefined };
    const pool = { query: handle, connect: async () => client } as unknown as Pool;
    return { pool, calls };
}

function jobs(pool: Pool) {
    const store = {
        pool,
        access: { claims: async () => ({ email, userRoles: ['Главный админ'], projects: [] }) },
    } as never;
    return new DeviceJobs(store as never, {} as never, {} as never, {} as never, {} as never);
}

/** Все флаги включены: post-commit проверка requireFeaturesEnabled проходит. */
function stubFeatureFlags() {
    vi.stubGlobal('fetch', async (url: unknown) => {
        if (String(url).includes('/internal/feature-flags/evaluated'))
            return {
                ok: true,
                body: (async function* () {
                    yield Buffer.from(
                        JSON.stringify({ flags: Object.fromEntries(FEATURE_FLAG_KEYS.map((k) => [k, true])) }),
                    );
                })(),
            };
        return { ok: true };
    });
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('DeviceJobs.claim — BRIDGE_JOB_LANES', () => {
    it('офф: активная запись блокирует выдачу, lane-счётчики не читаются', async () => {
        vi.stubEnv('BRIDGE_JOB_LANES', '0');
        const { pool, calls } = fakePool({
            active: true,
            queued: [readJob(), writeJob()],
            lanes: { readRunning: 0, writeRunning: 0 },
        });
        await expect(jobs(pool).claim(device)).resolves.toBeNull();
        expect(calls.claims).toEqual([]);
        expect(calls.laneCountQueries).toBe(0);
        // Выборка очереди не выполнялась (в отличие от expire-перехода, который содержит state='queued').
        expect(calls.statements.some((sql) => sql.startsWith('SELECT * FROM bridge_jobs'))).toBe(false);
    });

    it('офф: без активных выдаёт старейшую ожидающую (полный путь)', async () => {
        vi.stubEnv('BRIDGE_JOB_LANES', '0');
        stubFeatureFlags();
        const { pool, calls } = fakePool({
            active: false,
            queued: [readJob(), writeJob()],
            lanes: { readRunning: 0, writeRunning: 0 },
        });
        const read = readJob();
        const result = await jobs(pool).claim(device);
        expect(result).toMatchObject({ id: read.id, kind: 'scan-opencode-models', state: 'running' });
        expect(calls.claims).toHaveLength(1);
        expect(calls.claims[0].id).toBe(read.id);
        expect(calls.claims[0].lease).toEqual(expect.any(String));
        expect(calls.laneCountQueries).toBe(0);
    });

    it('он: свободный read-слот — выдача читающему', async () => {
        vi.stubEnv('BRIDGE_JOB_LANES', '1');
        vi.stubEnv('BRIDGE_JOB_READ_LANES', '2');
        stubFeatureFlags();
        const { pool, calls } = fakePool({
            active: false,
            queued: [readJob(), writeJob()],
            lanes: { readRunning: 1, writeRunning: 1 },
        });
        const read = readJob();
        const result = await jobs(pool).claim(device);
        expect(result?.id).toBe(read.id);
        expect(calls.laneCountQueries).toBe(1);
        expect(calls.claims[0].id).toBe(read.id);
    });

    it('он: read-слоты полны и запись активна — ожидание', async () => {
        vi.stubEnv('BRIDGE_JOB_LANES', '1');
        vi.stubEnv('BRIDGE_JOB_READ_LANES', '2');
        const { pool, calls } = fakePool({
            active: false,
            queued: [readJob()],
            lanes: { readRunning: 2, writeRunning: 1 },
        });
        await expect(jobs(pool).claim(device)).resolves.toBeNull();
        expect(calls.laneCountQueries).toBe(1);
        expect(calls.claims).toEqual([]);
    });

    it('он: запись не активна — выдача пишущему, хотя читать ждут раньше', async () => {
        vi.stubEnv('BRIDGE_JOB_LANES', '1');
        vi.stubEnv('BRIDGE_JOB_READ_LANES', '2');
        stubFeatureFlags();
        const { pool, calls } = fakePool({
            active: false,
            queued: [readJob(), writeJob()],
            lanes: { readRunning: 2, writeRunning: 0 },
        });
        const write = writeJob();
        const result = await jobs(pool).claim(device);
        expect(result?.id).toBe(write.id);
        expect(calls.claims[0].id).toBe(write.id);
    });

    it('он: оба лена заняты — ожидание, очередь не тронута', async () => {
        vi.stubEnv('BRIDGE_JOB_LANES', '1');
        vi.stubEnv('BRIDGE_JOB_READ_LANES', '2');
        const { pool, calls } = fakePool({
            active: false,
            queued: [readJob(), writeJob()],
            lanes: { readRunning: 2, writeRunning: 1 },
        });
        await expect(jobs(pool).claim(device)).resolves.toBeNull();
        expect(calls.laneCountQueries).toBe(1);
        expect(calls.claims).toEqual([]);
    });

    it('он: свободны оба лена — приоритет у читающего', async () => {
        vi.stubEnv('BRIDGE_JOB_LANES', '1');
        vi.stubEnv('BRIDGE_JOB_READ_LANES', '2');
        stubFeatureFlags();
        const { pool, calls } = fakePool({
            active: false,
            queued: [readJob(), writeJob()],
            lanes: { readRunning: 0, writeRunning: 0 },
        });
        const read = readJob();
        const result = await jobs(pool).claim(device);
        expect(result?.id).toBe(read.id);
        expect(calls.claims[0].id).toBe(read.id);
    });
});
