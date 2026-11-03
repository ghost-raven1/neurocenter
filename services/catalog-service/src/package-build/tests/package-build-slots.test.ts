import { describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { PackageBuildRepository, TOOL_BUILD_MAX_RUN_SLOTS } from '../package-build.repository';
import type { IBuildConfiguration, IBuildRow } from '../package-build.model';

const build = (id: string): IBuildRow => ({
    id,
    actor: 'admin@local',
    request_key: 'key-' + id,
    request_hash: 'hash-' + id,
    config: { name: 'tool-' + id } as unknown as IBuildConfiguration,
    state: 'QUEUED',
    percent: 0,
    message: 'В очереди',
    result: null,
    error: null,
    created_at: '2026-11-02T00:00:00.000Z',
    updated_at: '2026-11-02T00:00:00.000Z',
});

interface IEnv {
    /** Занятые слоты RUNNING-сборок; сценарии всегда занимают самые младшие. */
    runningSlots: number[];
    queued: IBuildRow[];
    generateSeriesParams: number[];
    claimed: Array<{ id: string; runSlot: number }>;
    statements: string[];
}

/**
 * Скриптованный пул-клиент: повторяет транзакцию takeQueued —
 * BEGIN, lock/statement таймауты, поиск свободного слота, выбор QUEUED,
 * saveProgress (RUNNING + operations), фиксация execution_* с run_slot, COMMIT.
 */
function fakeLease(env: IEnv): PoolClient {
    const client = {
        release: () => undefined,
        async query(sql: string, params: unknown[] = []) {
            env.statements.push(sql);
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
            if (sql.includes("current_setting('lock_timeout')"))
                return { rows: [{ lock_ms: '100', statement_ms: '200' }] };
            if (sql.includes('set_config(')) return { rows: [] };
            if (sql.includes('FROM generate_series(0,$1-1)')) {
                const slots = Math.max(1, Math.min(Math.trunc(params[0] as number) || 1, TOOL_BUILD_MAX_RUN_SLOTS));
                env.generateSeriesParams.push(slots);
                const free = slots - env.runningSlots.length;
                return { rows: free > 0 ? [{ run_slot: env.runningSlots.length }] : [] };
            }
            if (sql.includes("WHERE state='QUEUED'")) return { rows: env.queued.slice(0, 1) };
            if (sql.startsWith('UPDATE tool_build_jobs SET state=$2'))
                return {
                    rows: [{ ...env.queued[0], state: 'RUNNING' as const, percent: 0, message: 'Подготовка сборки' }],
                };
            if (sql.includes('execution_nonce=$2')) {
                const runSlot = params[4] as number;
                env.claimed.push({ id: params[0] as string, runSlot });
                return {
                    rows: [
                        { ...env.queued[0], state: 'RUNNING' as const, run_slot: runSlot, execution_nonce: params[1] },
                    ],
                };
            }
            if (sql.startsWith('INSERT INTO operations')) return { rows: [] };
            throw new Error('Непредвиденный SQL в takeQueued: ' + sql);
        },
    };
    return client as unknown as PoolClient;
}

const repository = (env: IEnv) => new PackageBuildRepository({} as unknown as Pool, undefined);

describe('PackageBuildRepository.takeQueued — модель слотов (миграция 52)', () => {
    it('по умолчанию берёт только слот 0 и не трогает очередь, если он занят', async () => {
        const env: IEnv = {
            runningSlots: [0],
            queued: [build('q1')],
            generateSeriesParams: [],
            claimed: [],
            statements: [],
        };
        const result = await repository(env).takeQueued(fakeLease(env));
        expect(result).toBeUndefined();
        expect(env.generateSeriesParams).toEqual([1]);
        expect(env.claimed).toEqual([]);
        expect(env.statements.some((sql) => sql.includes("WHERE state='QUEUED'"))).toBe(false);
        expect(env.statements).toContain('COMMIT');
    });

    it('берёт старейшую QUEUED в первый свободный слот выше занятых', async () => {
        const q1 = build('q1');
        const q2 = build('q2');
        const env: IEnv = {
            runningSlots: [0, 1],
            queued: [q1, q2],
            generateSeriesParams: [],
            claimed: [],
            statements: [],
        };
        const result = await repository(env).takeQueued(fakeLease(env), 3);
        expect(env.generateSeriesParams).toEqual([3]);
        expect(env.claimed).toEqual([{ id: 'q1', runSlot: 2 }]);
        expect(result?.id).toBe('q1');
        expect(result?.state).toBe('RUNNING');
        expect(env.statements).toContain('COMMIT');
    });

    it('пустая таблица: слот 0, старейшая запись', async () => {
        const env: IEnv = {
            runningSlots: [],
            queued: [build('q1')],
            generateSeriesParams: [],
            claimed: [],
            statements: [],
        };
        const result = await repository(env).takeQueued(fakeLease(env));
        expect(env.generateSeriesParams).toEqual([1]);
        expect(env.claimed).toEqual([{ id: 'q1', runSlot: 0 }]);
        expect(result?.run_slot).toBe(0);
    });

    it('все слоты заняты — не берёт задание', async () => {
        const env: IEnv = {
            runningSlots: [0, 1, 2, 3],
            queued: [build('q1')],
            generateSeriesParams: [],
            claimed: [],
            statements: [],
        };
        const result = await repository(env).takeQueued(fakeLease(env), 4);
        expect(result).toBeUndefined();
        expect(env.generateSeriesParams).toEqual([4]);
        expect(env.claimed).toEqual([]);
        expect(env.statements.some((sql) => sql.includes("WHERE state='QUEUED'"))).toBe(false);
    });

    it('нет ожидающих — не берёт, хотя слот свободен', async () => {
        const env: IEnv = {
            runningSlots: [],
            queued: [],
            generateSeriesParams: [],
            claimed: [],
            statements: [],
        };
        const result = await repository(env).takeQueued(fakeLease(env));
        expect(result).toBeUndefined();
        expect(env.claimed).toEqual([]);
    });

    it('ограничивает число слотов жёстким пределом (99 → 4)', async () => {
        const env: IEnv = {
            runningSlots: [0, 1, 2],
            queued: [build('q1')],
            generateSeriesParams: [],
            claimed: [],
            statements: [],
        };
        const result = await repository(env).takeQueued(fakeLease(env), 99);
        expect(env.generateSeriesParams).toEqual([4]);
        expect(env.claimed).toEqual([{ id: 'q1', runSlot: 3 }]);
        expect(result?.run_slot).toBe(3);
    });

    it('дробное и недостоверное число слотов округляется к младшему целому, не меньше 1', async () => {
        const frac: IEnv = {
            runningSlots: [0],
            queued: [build('q1')],
            generateSeriesParams: [],
            claimed: [],
            statements: [],
        };
        await repository(frac).takeQueued(fakeLease(frac), 2.9);
        expect(frac.generateSeriesParams).toEqual([2]);
        expect(frac.claimed).toEqual([{ id: 'q1', runSlot: 1 }]);

        const zero: IEnv = {
            runningSlots: [],
            queued: [build('q2')],
            generateSeriesParams: [],
            claimed: [],
            statements: [],
        };
        await repository(zero).takeQueued(fakeLease(zero), 0);
        expect(zero.generateSeriesParams).toEqual([1]);
        expect(zero.claimed).toEqual([{ id: 'q2', runSlot: 0 }]);

        const negative: IEnv = {
            runningSlots: [],
            queued: [build('q3')],
            generateSeriesParams: [],
            claimed: [],
            statements: [],
        };
        await repository(negative).takeQueued(fakeLease(negative), -5);
        expect(negative.generateSeriesParams).toEqual([1]);
        expect(negative.claimed).toEqual([{ id: 'q3', runSlot: 0 }]);
    });

    it('фиксирует run_slot в том же UPDATE, что и execution_nonce', async () => {
        const env: IEnv = {
            runningSlots: [0],
            queued: [build('q1')],
            generateSeriesParams: [],
            claimed: [],
            statements: [],
        };
        await repository(env).takeQueued(fakeLease(env), 2);
        const claimSql = env.statements.find((sql) => sql.includes('execution_nonce=$2'));
        expect(claimSql).toContain('run_slot=$5');
        expect(claimSql).toContain('WHERE id=$1 RETURNING *');
        const progressSql = env.statements.find((sql) => sql.startsWith('UPDATE tool_build_jobs SET state=$2'));
        expect(progressSql).toBeDefined();
        expect(env.statements.indexOf(progressSql as string)).toBeLessThan(env.statements.indexOf(claimSql as string));
    });
});
