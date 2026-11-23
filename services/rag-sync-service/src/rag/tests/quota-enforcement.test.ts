import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RagDb } from '../rag-db';
import { RagGenerations } from '../rag-generations';
import {
    QuotaError,
    checkQuota,
    decideQuota,
    renderQuotaMetrics,
} from '../../../../shared/quota-guard.cjs';

const RETENTION_EXCEEDED =
    'Лимит объёма базы знаний проекта превышен. Операция не начата. Обратитесь к администратору.';
const QUOTA_UNAVAILABLE = 'Лимиты проекта не подтверждены. Операция не начата. Обратитесь к администратору.';
const norm = (sql: string) => String(sql).replace(/\s+/g, ' ').trim();

/** Снимок accounting: used/limit измерения retention, остальные измерения нулевые. */
const quotaResponse = (used: number, limit: number) =>
    new Response(
        JSON.stringify({
            used: { current: 0, retention: used, staging: 0 },
            limits: { current: 0, retention: limit, staging: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );

const metricValue = (dimension: string, reason: string): number => {
    const line = renderQuotaMetrics()
        .split('\n')
        .find((entry) => entry.startsWith(`neurocenter_quota_rejections_total{dimension="${dimension}",reason="${reason}"}`));
    return line ? Number(line.split(' ').pop()) : 0;
};

const expectQuotaError = async (promise: Promise<unknown>, statusCode: number, message: string): Promise<void> => {
    const error = await promise.catch((value) => value);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(statusCode);
    expect((error as HttpException).message).toBe(message);
};

describe('decideQuota (AD-D4: единое чистое решение)', () => {
    it('used + оценка == лимит — допущено (граница включена)', () => {
        expect(decideQuota({ used: 100, limit: 150, estimateBytes: 50 })).toEqual({
            allowed: true,
            unlimited: false,
            used: 100,
            limit: 150,
            estimateBytes: 50,
        });
    });

    it('used + оценка > лимит — отказ', () => {
        expect(decideQuota({ used: 100, limit: 149, estimateBytes: 50 }).allowed).toBe(false);
    });

    it('limit=0 — безлимит: любая запись допущена', () => {
        expect(decideQuota({ used: 9_000_000_000, limit: 0, estimateBytes: 1_000_000_000 })).toEqual({
            allowed: true,
            unlimited: true,
            used: 9_000_000_000,
            limit: 0,
            estimateBytes: 1_000_000_000,
        });
    });

    it('нецелые и отрицательные значения — TypeError', () => {
        expect(() => decideQuota({ used: -1, limit: 10, estimateBytes: 1 })).toThrowError(TypeError);
        expect(() => decideQuota({ used: 0, limit: 10.5, estimateBytes: 1 })).toThrowError(TypeError);
        expect(() => decideQuota({ used: 0, limit: 10, estimateBytes: -1 })).toThrowError(TypeError);
    });
});

describe('checkQuota (снимок accounting, fail-closed)', () => {
    it('читает GET /internal/projects/:id/quota-usage с internal-токеном и допускает', async () => {
        const fetchImpl = vi.fn(async () => quotaResponse(10, 1000)) as unknown as typeof globalThis.fetch;
        const decision = await checkQuota({
            projectId: 'proj-key',
            dimension: 'retention',
            estimateBytes: 100,
            catalogUrl: 'http://catalog:4100/',
            internalToken: 'internal-token',
            fetchImpl,
        });
        expect(decision).toEqual({ allowed: true, used: 10, limit: 1000 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://catalog:4100/internal/projects/proj-key/quota-usage');
        expect(init.method).toBe('GET');
        expect(init.headers).toEqual({ 'x-neurocenter-internal': 'internal-token' });
    });

    it('used + оценка > limit — QuotaError 507 и rejection-метрика +1', async () => {
        const exceeded = vi.fn(async () => quotaResponse(950, 1000)) as unknown as typeof globalThis.fetch;
        const before = metricValue('retention', 'exceeded');
        const error = await checkQuota({
            projectId: 'p1',
            dimension: 'retention',
            estimateBytes: 100,
            fetchImpl: exceeded,
        }).catch((value) => value);
        expect(error).toBeInstanceOf(QuotaError);
        expect((error as QuotaError).statusCode).toBe(507);
        expect((error as QuotaError).code).toBe('QUOTA_EXCEEDED');
        expect(metricValue('retention', 'exceeded')).toBe(before + 1);
    });

    it('сеть недоступна — fail-closed QuotaError 503', async () => {
        const down = vi.fn(async () => {
            throw new Error('network down');
        }) as unknown as typeof globalThis.fetch;
        const error = await checkQuota({
            projectId: 'p1',
            dimension: 'retention',
            estimateBytes: 100,
            fetchImpl: down,
        }).catch((value) => value);
        expect(error).toBeInstanceOf(QuotaError);
        expect((error as QuotaError).statusCode).toBe(503);
        expect((error as QuotaError).code).toBe('QUOTA_UNAVAILABLE');
    });

    it('не-ok статус каталога — fail-closed 503', async () => {
        const bad = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof globalThis.fetch;
        const error = await checkQuota({
            projectId: 'p1',
            dimension: 'retention',
            estimateBytes: 100,
            fetchImpl: bad,
        }).catch((value) => value);
        expect(error).toBeInstanceOf(QuotaError);
        expect((error as QuotaError).statusCode).toBe(503);
    });

    it('повреждённый снимок (не-JSON) — fail-closed 503', async () => {
        const malformed = vi.fn(async () =>
            new Response('{не-json', { status: 200, headers: { 'content-type': 'application/json' } }),
        ) as unknown as typeof globalThis.fetch;
        const error = await checkQuota({
            projectId: 'p1',
            dimension: 'retention',
            estimateBytes: 100,
            fetchImpl: malformed,
        }).catch((value) => value);
        expect(error).toBeInstanceOf(QuotaError);
        expect((error as QuotaError).statusCode).toBe(503);
    });

    it('снимок без used/limits — fail-closed 503', async () => {
        const empty = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch;
        const error = await checkQuota({
            projectId: 'p1',
            dimension: 'retention',
            estimateBytes: 100,
            fetchImpl: empty,
        }).catch((value) => value);
        expect(error).toBeInstanceOf(QuotaError);
        expect((error as QuotaError).statusCode).toBe(503);
    });
});

describe('RagDb.applyDelta: enforcement retention ДО записи', () => {
    const generation = 'initial-' + 'a'.repeat(32);

    beforeEach(() => {
        vi.stubEnv('CATALOG_SERVICE_URL', 'http://catalog:4100');
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'internal-token');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const makeDb = () => {
        const db = new RagDb({ url: 'postgres://stub:5432/rag', scope: 'project' });
        const pool = {
            query: vi.fn(async () => {
                throw new Error('При отказе квоты база не должна быть тронута');
            }),
            connect: vi.fn(async () => {
                throw new Error('При отказе квоты соединение не должно открываться');
            }),
        };
        (db as unknown as { pool: unknown }).pool = pool;
        return { db, pool };
    };

    it('сверх retentionBytesLimit — 507, пакет не начался (без запросов и соединений)', async () => {
        const { db, pool } = makeDb();
        // used + оценка (16 МиB) > limit → отказ ДО любого обращения к БД.
        const fetchImpl = vi.fn(async () => quotaResponse(990_000_000, 1_000_000_000));
        vi.stubGlobal('fetch', fetchImpl);
        await expectQuotaError(db.applyDelta('proj-key', generation, [], []), 507, RETENTION_EXCEEDED);
        expect(pool.query).not.toHaveBeenCalled();
        expect(pool.connect).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
            'http://catalog:4100/internal/projects/proj-key/quota-usage',
        );
    });

    it('accounting недоступен — fail-closed 503, пакет не начался', async () => {
        const { db, pool } = makeDb();
        const fetchImpl = vi.fn(async () => {
            throw new Error('catalog down');
        });
        vi.stubGlobal('fetch', fetchImpl);
        await expectQuotaError(db.applyDelta('proj-key', generation, [], []), 503, QUOTA_UNAVAILABLE);
        expect(pool.query).not.toHaveBeenCalled();
        expect(pool.connect).not.toHaveBeenCalled();
    });

    it('limit=0 (unlimited) — проверка пройдена, запись дошла до транзакции', async () => {
        const { db, pool } = makeDb();
        const fetchImpl = vi.fn(async () => quotaResponse(5_000_000_000, 0));
        vi.stubGlobal('fetch', fetchImpl);
        const queries: string[] = [];
        const client = {
            query: vi.fn(async (sql: string) => {
                queries.push(norm(sql));
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
                throw new Error('SENTINEL: квотная проверка пройдена, запись началась');
            }),
            release: vi.fn(),
        };
        pool.connect.mockResolvedValue(client);
        await expect(db.applyDelta('proj-key', generation, [], [])).rejects.toThrowError(/SENTINEL/);
        expect(queries[0]).toBe('BEGIN');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

describe('RagGenerations.create: enforcement retention ДО копирования поколения', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const sourceGeneration = 'initial-' + 'b'.repeat(32);
    const profile = { provider: 'ollama', model: 'qwen3-embedding:4b', dimension: 2560 };
    // Пустое исходное поколение: hash = sha256(''), оценка = max(16 MiB, 0).
    const expectedSource = createHash('sha256').update('').digest('hex');
    const insertGeneration =
        "INSERT INTO rag_generations(id,project_key,index_profile,state,source_generation,source_snapshot,source_rows) VALUES($1,$2,$3::jsonb,'building',$4,$5,$6)";

    beforeEach(() => {
        vi.stubEnv('CATALOG_SERVICE_URL', 'http://catalog:4100');
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'internal-token');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const makeClient = (reachedInsert: boolean) => {
        const queries: string[] = [];
        const client = {
            queries,
            query: vi.fn(async (sql: string) => {
                const request = norm(sql);
                queries.push(request);
                if (request === 'BEGIN' || request === 'ROLLBACK') return { rows: [] };
                if (request === 'SELECT pg_advisory_xact_lock($1)') return { rows: [] };
                if (request === 'SELECT * FROM rag_generations WHERE id=$1 FOR UPDATE') return { rows: [] };
                if (request.startsWith('SELECT id,file_path,')) return { rows: [] };
                if (request === insertGeneration) {
                    if (reachedInsert) throw new Error('SENTINEL: квотная проверка пройдена, копия началась');
                    throw new Error('Непредвиденный SQL: ' + request);
                }
                throw new Error('Непредвиденный SQL: ' + request);
            }),
            release: vi.fn(),
        };
        return client;
    };

    it('сверх retentionBytesLimit — 507, строки поколения не скопированы', async () => {
        const pool = { connect: vi.fn() };
        const client = makeClient(false);
        pool.connect.mockResolvedValue(client);
        const generations = new RagGenerations(pool as never);
        const fetchImpl = vi.fn(async () => quotaResponse(0, 100));
        vi.stubGlobal('fetch', fetchImpl);
        await expectQuotaError(
            generations.create('proj-key', id, sourceGeneration, profile, expectedSource),
            507,
            RETENTION_EXCEEDED,
        );
        expect(client.queries).not.toContain(insertGeneration);
        expect(client.queries).toContain('ROLLBACK');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('limit=0 (unlimited) — копия поколения началась (INSERT достигнут)', async () => {
        const pool = { connect: vi.fn() };
        const client = makeClient(true);
        pool.connect.mockResolvedValue(client);
        const generations = new RagGenerations(pool as never);
        const fetchImpl = vi.fn(async () => quotaResponse(0, 0));
        vi.stubGlobal('fetch', fetchImpl);
        await expect(generations.create('proj-key', id, sourceGeneration, profile, expectedSource)).rejects.toThrowError(
            /SENTINEL/,
        );
        expect(client.queries).toContain(insertGeneration);
    });
});
