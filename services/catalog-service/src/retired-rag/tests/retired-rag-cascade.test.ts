import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ragRequestHash } from '../../../../shared/rag-index-contract.cjs';
import { RetiredRagService } from '../retired-rag.service';
import type { IRetirement } from '../retired-rag.interfaces';

const RETIREMENT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const PROJECT_ID = 'proj-1';
const ACTOR = 'main@local';
const DIGEST = 'd'.repeat(64);

const RETIREMENT: IRetirement = {
    id: RETIREMENT_ID,
    project_id: PROJECT_ID,
    project_name: 'QA',
    deleted_at: new Date().toISOString(),
    retain_until: null,
    retention_revision: 0,
    retention_reason: '',
    origin: 'deletion',
    deleted_resources: null,
};

const FACTS = {
    identity: { cluster: 'local', oid: '12345', marker: 'marker', databaseName: 'rag_proj_1', projectId: PROJECT_ID },
    retirementId: RETIREMENT_ID,
    bytes: 1024,
    chunks: 3,
    generations: 1,
    backupPolicy: 'retained-until-explicit-purge',
    preserves: ['backups', 'lance-snapshots', 'local-files'],
};

interface IPurgeJob {
    id: string;
    retirement_id: string;
    request_key: string;
    preview_id: string;
    digest: string;
    actor: string;
    state: 'queued' | 'running' | 'failed' | 'succeeded';
    message: string;
    receipt: unknown;
    created_at: string;
    updated_at: string;
}

function job(overrides: Partial<IPurgeJob> = {}): IPurgeJob {
    return {
        id: 'f1e2d3c4-b5a6-4789-0abc-def123456789',
        retirement_id: RETIREMENT_ID,
        request_key: RETIREMENT_ID,
        preview_id: '0a1b2c3d-4e5f-4678-90ab-cdef12345678',
        digest: DIGEST,
        actor: ACTOR,
        state: 'succeeded',
        message: '',
        receipt: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...overrides,
    };
}

const jsonResponse = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

/** Мини-подложка под pool RetiredRagService: только SQL, который ходит cascadePurge. */
function fixture(options: { jobs?: IPurgeJob[]; withRetirement?: boolean } = {}) {
    const state = {
        retirement: options.withRetirement === false ? null : RETIREMENT,
        jobs: options.jobs ?? ([] as IPurgeJob[]),
        previews: [] as Array<{ id: string; retirement_id: string; digest: string; retention_revision: number }>,
        calls: [] as string[],
    };
    const query = async (sql: string, args: unknown[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        state.calls.push(s);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        if (s.startsWith('SELECT * FROM project_retirements WHERE project_id='))
            return { rows: state.retirement ? [state.retirement] : [] };
        if (s.startsWith('SELECT * FROM project_retirements WHERE id='))
            return { rows: state.retirement ? [state.retirement] : [] };
        if (s.startsWith('SELECT * FROM retired_rag_purges WHERE request_key='))
            return { rows: state.jobs.filter((item) => item.request_key === args[0]) };
        if (s.startsWith('SELECT * FROM retired_rag_purges WHERE id='))
            return { rows: state.jobs.filter((item) => item.id === args[0]) };
        if (s.startsWith('SELECT * FROM retired_rag_previews WHERE id=$1 AND retirement_id=$2'))
            return {
                rows: state.previews.filter((item) => item.id === args[0] && item.retirement_id === args[1]),
            };
        if (s.startsWith('INSERT INTO retired_rag_previews')) {
            const [id, retirementId, digest] = args as [string, string, string];
            state.previews.push({ id, retirement_id: retirementId, digest, retention_revision: 0 });
            return { rows: [] };
        }
        if (s.startsWith('INSERT INTO retired_rag_purges')) {
            const [id, retirementId, requestKey, previewId, digest, actor] = args as [
                string,
                string,
                string,
                string,
                string,
                string,
            ];
            const created = job({
                id,
                retirement_id: retirementId,
                request_key: requestKey,
                preview_id: previewId,
                digest,
                actor,
                state: 'queued',
            });
            state.jobs.push(created);
            return { rows: [created] };
        }
        if (s.startsWith('INSERT INTO security_events')) return { rows: [] };
        if (s.startsWith('SELECT to_regclass')) return { rows: [{ name: null }] };
        if (s.startsWith('SELECT 1 FROM projects WHERE id=')) return { rows: [] };
        throw new Error('Непредвиденный SQL: ' + s);
    };
    const pool = { query, connect: async () => ({ query, release: vi.fn() }) };
    return { state, pool };
}

function makeService(pool: unknown): RetiredRagService {
    const service = new RetiredRagService({} as never, {} as never, {} as never);
    (service as any).pool = pool;
    return service;
}

describe('RetiredRagService.cascadePurge (Entry 5.11)', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('retirement не зафиксирован: absent без обращений к RAG', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { pool } = fixture({ withRetirement: false });
        const result = await makeService(pool).cascadePurge(PROJECT_ID, ACTOR);
        expect(result).toEqual({ state: 'absent', detail: 'сохранённая база не зафиксирована' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('завершённое задание: deleted без новых обращений к RAG', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { pool } = fixture({ jobs: [job({ state: 'succeeded' })] });
        const result = await makeService(pool).cascadePurge(PROJECT_ID, ACTOR);
        expect(result).toMatchObject({ state: 'deleted' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('задание в работе (queued/running): pending', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        for (const state of ['queued', 'running'] as const) {
            const { pool } = fixture({ jobs: [job({ state })] });
            const result = await makeService(pool).cascadePurge(PROJECT_ID, ACTOR);
            expect(result).toMatchObject({ state: 'pending' });
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('неудачное задание: повтор через retry, сбой retry — failed', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const failedFixture = fixture({ jobs: [job({ state: 'failed' })] });
        const service = makeService(failedFixture.pool);
        const retry = vi.spyOn(service, 'retry').mockResolvedValue(job({ state: 'queued' }) as never);
        const retried = await service.cascadePurge(PROJECT_ID, ACTOR);
        expect(retried).toMatchObject({ state: 'pending' });
        expect(retry).toHaveBeenCalledWith(job({ state: 'failed' }).id, { digest: DIGEST }, ACTOR);

        const brokenFixture = fixture({ jobs: [job({ state: 'failed' })] });
        const broken = makeService(brokenFixture.pool);
        vi.spyOn(broken, 'retry').mockRejectedValue(new Error('Повтор недоступен.'));
        const failed = await broken.cascadePurge(PROJECT_ID, ACTOR);
        expect(failed).toMatchObject({ state: 'failed', detail: 'Повтор недоступен.' });
    });

    it('RAG недоступен при инвентаре: pending', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('ECONNREFUSED');
            }),
        );
        const { pool } = fixture();
        const result = await makeService(pool).cascadePurge(PROJECT_ID, ACTOR);
        expect(result).toMatchObject({ state: 'pending' });
    });

    it('базы в инвентаре нет (нет / present=false / purged): absent', async () => {
        for (const inventory of [
            [],
            [{ projectId: PROJECT_ID, present: false, state: 'active' }],
            [{ projectId: PROJECT_ID, present: true, state: 'purged' }],
        ]) {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => jsonResponse(inventory)),
            );
            const { pool } = fixture();
            const result = await makeService(pool).cascadePurge(PROJECT_ID, ACTOR);
            expect(result).toMatchObject({ state: 'absent' });
        }
    });

    it('превью с 404/409/503: absent/failed/pending', async () => {
        const inventory = [{ projectId: PROJECT_ID, present: true, state: 'active' }];
        for (const [status, expected] of [
            [404, 'absent'],
            [409, 'failed'],
            [503, 'pending'],
        ] as const) {
            // Инвентарь проходит, ошибается только preview.
            vi.stubGlobal(
                'fetch',
                vi.fn(async (url: string) =>
                    String(url).endsWith('/preview') ? jsonResponse(null, status) : jsonResponse(inventory),
                ),
            );
            const { pool } = fixture();
            const result = await makeService(pool).cascadePurge(PROJECT_ID, ACTOR);
            expect(result).toMatchObject({ state: expected });
        }
    });

    it('новая база: превью + задание с request_key = id retirement, состояние pending', async () => {
        const inventory = [{ projectId: PROJECT_ID, present: true, state: 'active' }];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                const target = String(url);
                if (target.endsWith('/inventory')) return jsonResponse(inventory);
                if (target.endsWith('/preview')) return jsonResponse(FACTS);
                throw new Error('Непредвиденный URL: ' + target);
            }),
        );
        const { state, pool } = fixture();
        const service = makeService(pool);
        const launch = vi.spyOn(service as any, 'launch').mockImplementation(() => undefined);
        const result = await service.cascadePurge(PROJECT_ID, ACTOR);
        expect(result).toMatchObject({ state: 'pending' });
        expect(state.previews).toHaveLength(1);
        expect(state.jobs).toHaveLength(1);
        expect(state.jobs[0].request_key).toBe(RETIREMENT_ID);
        expect(state.jobs[0].digest).toBe(ragRequestHash(FACTS));
        expect(launch).toHaveBeenCalledTimes(1);
        expect(result.jobId).toBe(state.jobs[0].id);
    });

    it('повторный каскад с тем же retirement не создаёт второе задание', async () => {
        const { state, pool } = fixture({ jobs: [job({ state: 'queued' })] });
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const service = makeService(pool);
        await service.cascadePurge(PROJECT_ID, ACTOR);
        await service.cascadePurge(PROJECT_ID, ACTOR);
        expect(state.jobs).toHaveLength(1);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
