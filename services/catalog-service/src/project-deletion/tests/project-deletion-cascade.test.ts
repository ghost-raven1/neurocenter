import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
    DELETION_DOMAINS,
    hasOpenDeletion,
    isTerminalDeletion,
    ProjectDeletionCascadeService,
    type TDeletionReceipt,
} from '../project-deletion-cascade.service';

const PROJECT_ID = 'proj-1';
const MAIN_ADMIN = 'main@local';

interface IBlobRow {
    project_id: string;
    sha256: string;
    bytes: number;
    storage_id: string;
    version_id: string | null;
    state: string;
}

/** Мини-подложка под pool каскада: только SQL, который он издаёт. */
function cascadeFixture(
    options: {
        tables?: string[];
        receipts?: Record<string, TDeletionReceipt>;
        chatRemaining?: number;
        blobs?: IBlobRow[];
        snapshots?: number;
        backups?: number;
        mainAdmin?: string | null;
    } = {},
) {
    const state = {
        tables: new Set(options.tables ?? []),
        receipts: new Map<string, TDeletionReceipt>(
            Object.entries(options.receipts ?? {}).map(([projectId, receipt]) => [projectId, { ...receipt }]),
        ),
        chatRemaining: options.chatRemaining ?? 0,
        blobs: (options.blobs ?? []).map((blob) => ({ ...blob })),
        snapshots: options.snapshots ?? 0,
        backupRows: options.backups ?? 0,
        mainAdmin: options.mainAdmin === undefined ? MAIN_ADMIN : options.mainAdmin,
        deletes: [] as string[],
        calls: [] as string[],
    };
    const query = async (sql: string, args: unknown[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        state.calls.push(s);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        if (s.startsWith('SELECT email FROM platform_users'))
            return { rows: state.mainAdmin ? [{ email: state.mainAdmin }] : [] };
        if (s.startsWith('SELECT deleted_resources FROM project_retirements'))
            return { rows: [{ deleted_resources: state.receipts.get(String(args[0])) ?? null }] };
        if (s.startsWith('SELECT to_regclass(')) {
            const table = String(args[0]);
            return { rows: [{ name: state.tables.has(table) ? table : null }] };
        }
        if (s.startsWith('UPDATE project_retirements SET deleted_resources')) {
            const [key, value, projectId] = args as [string, string, string];
            const receipt = state.receipts.get(projectId) ?? {};
            receipt[key] = JSON.parse(value);
            state.receipts.set(projectId, receipt);
            return { rows: [] };
        }
        if (s.startsWith('SELECT count(*)::int AS n FROM model_chat_objects'))
            return { rows: [{ n: state.chatRemaining }] };
        if (s.startsWith('SELECT count(*)::int AS n FROM project_snapshot_blobs'))
            return { rows: [{ n: state.blobs.filter((item) => item.project_id === args[0]).length }] };
        if (
            s.startsWith(
                'SELECT sha256,bytes,storage_id,version_id,state FROM project_snapshot_blobs WHERE project_id=$1 AND sha256=$2',
            )
        )
            return {
                rows: state.blobs.filter(
                    (blob) => blob.project_id === args[0] && blob.sha256 === args[1] && blob.state === 'DELETING',
                ),
            };
        if (s.startsWith('SELECT sha256,bytes,storage_id,version_id,state FROM project_snapshot_blobs'))
            return { rows: state.blobs.filter((blob) => blob.project_id === args[0]) };
        if (s.startsWith('SELECT count(*)::int AS n FROM project_snapshots')) return { rows: [{ n: state.snapshots }] };
        if (s.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (s.startsWith("UPDATE project_snapshot_blobs SET state='DELETING'")) {
            state.blobs.forEach((blob) => {
                if (blob.project_id === args[0] && blob.sha256 === args[1]) blob.state = 'DELETING';
            });
            return { rows: [] };
        }
        if (s.startsWith('DELETE FROM project_snapshot_blobs')) {
            state.blobs = state.blobs.filter(
                (blob) =>
                    !(
                        blob.project_id === args[0] &&
                        blob.sha256 === args[1] &&
                        blob.storage_id === args[2] &&
                        (args[3] === null ? blob.version_id === null : blob.version_id === args[3])
                    ),
            );
            return { rows: [] };
        }
        if (s.startsWith('DELETE FROM project_backups')) {
            const count = state.backupRows;
            state.backupRows = 0;
            return { rows: [], rowCount: count };
        }
        if (s.startsWith('DELETE FROM')) {
            state.deletes.push(s);
            return { rows: [] };
        }
        if (s.startsWith('SELECT pg_advisory_unlock')) return { rows: [] };
        throw new Error('Непредвиденный SQL: ' + s);
    };
    const pool = { query, connect: async () => ({ query, release: vi.fn() }) };
    return { state, pool };
}

const jsonResponse = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

function makeService(
    pool: unknown,
    options: {
        backupDir: string;
        rag?: ReturnType<typeof vi.fn>;
        skillsResponse?: unknown;
        skillsFetch?: ReturnType<typeof vi.fn>;
        snapshotStorage?: { remove: ReturnType<typeof vi.fn> };
    },
) {
    const rag = options.rag ?? vi.fn(async () => ({ state: 'deleted' as const }));
    const skillsFetch = options.skillsFetch ?? vi.fn(async () => jsonResponse({ deleted: true, skills: 2 }));
    vi.stubGlobal('fetch', skillsFetch);
    const service = new ProjectDeletionCascadeService({ cascadePurge: rag } as never, {
        pool: pool as never,
        snapshotStorage: options.snapshotStorage,
        skillsUrl: 'http://skills.test',
        backupDir: options.backupDir,
    });
    return { service, rag, skillsFetch };
}

const blob = (overrides: Partial<IBlobRow> = {}): IBlobRow => ({
    project_id: PROJECT_ID,
    sha256: 'b'.repeat(64),
    bytes: 10,
    storage_id: 's1',
    version_id: 'v1',
    state: 'ACTIVE',
    ...overrides,
});

describe('ProjectDeletionCascadeService (Entry 5.11)', () => {
    let backupDir: string;

    beforeEach(async () => {
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-cascade-backups-'));
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        await fs.rm(backupDir, { recursive: true, force: true });
    });

    it('собирает квитанцию по всем пяти доменам и передаёт главному администратору пург RAG', async () => {
        const { state, pool } = cascadeFixture({
            tables: ['model_chat_objects', 'project_backups'],
            backups: 1,
        });
        const { service, rag } = makeService(pool, { backupDir });
        const receipt = await service.run(PROJECT_ID, 'project-admin@local');

        expect(rag).toHaveBeenCalledWith(PROJECT_ID, MAIN_ADMIN);
        for (const domain of DELETION_DOMAINS) expect(receipt[domain]?.at).toBeTruthy();
        expect(receipt.rag?.state).toBe('deleted');
        expect(receipt.chat?.state).toBe('absent');
        expect(receipt.snapshots?.state).toBe('absent');
        expect(receipt.skills?.state).toBe('deleted');
        expect(receipt.skills?.skills).toBe(2);
        expect(receipt.dumps).toMatchObject({ state: 'deleted', files: 1, directory: false });
        expect(state.receipts.get(PROJECT_ID)).toEqual(receipt);
    });

    it('битые подсистемы не роняют каскад: домены фиксируются failed/pending', async () => {
        const blocker = path.join(backupDir, 'blocker');
        await fs.writeFile(blocker, 'не каталог', 'utf8');
        const { state, pool } = cascadeFixture();
        const { service } = makeService(pool, {
            backupDir: blocker,
            rag: vi.fn(async () => {
                throw new Error('RAG down');
            }),
            skillsFetch: vi.fn(async () => {
                throw new Error('ECONNREFUSED');
            }),
        });
        const receipt = await service.run(PROJECT_ID, 'admin');

        expect(receipt.rag?.state).toBe('failed');
        expect(receipt.rag?.detail).toContain('RAG down');
        expect(receipt.skills?.state).toBe('pending');
        expect(receipt.dumps?.state).toBe('failed');
        expect(receipt.chat?.state).toBe('absent');
        expect(receipt.snapshots?.state).toBe('absent');
        expect(hasOpenDeletion(state.receipts.get(PROJECT_ID)!)).toBe(true);
    });

    it('терминальные домены не повторяются: повторный run не трогает deleted/absent', async () => {
        const { pool } = cascadeFixture({
            receipts: {
                [PROJECT_ID]: {
                    rag: { state: 'deleted', at: new Date(0).toISOString() },
                    chat: { state: 'absent', at: new Date(0).toISOString() },
                },
            },
        });
        const rag = vi.fn();
        const { service, skillsFetch } = makeService(pool, { backupDir, rag });
        const receipt = await service.run(PROJECT_ID, 'admin');

        expect(rag).not.toHaveBeenCalled();
        expect(skillsFetch).toHaveBeenCalledTimes(1);
        expect(receipt.rag).toEqual({ state: 'deleted', at: new Date(0).toISOString() });
        expect(receipt.chat).toEqual({ state: 'absent', at: new Date(0).toISOString() });
    });

    it('S3-объекты чата, которые ещё не дотравили: pending с остатком', async () => {
        const { pool } = cascadeFixture({ tables: ['model_chat_objects'], chatRemaining: 3 });
        const { service } = makeService(pool, { backupDir });
        const receipt = await service.run(PROJECT_ID, 'admin');
        expect(receipt.chat).toMatchObject({ state: 'pending', remaining: 3 });
    });

    it('снимки: подтверждённое удаление блоков очищает и метаданные, состояние deleted', async () => {
        const metadataTables = [
            'project_snapshot_blobs',
            'project_snapshot_blob_refs',
            'project_snapshot_blob_writes',
            'project_snapshot_profiles',
            'project_snapshot_commands',
            'project_snapshot_cancelled_requests',
            'project_snapshot_cancelled_commands',
            'project_snapshots',
        ];
        const remove = vi.fn(async () => undefined);
        const { state, pool } = cascadeFixture({
            tables: metadataTables,
            blobs: [blob(), blob({ sha256: 'c'.repeat(64), version_id: null, state: 'DELETING' })],
            snapshots: 2,
        });
        const { service } = makeService(pool, { backupDir, snapshotStorage: { remove } });
        const receipt = await service.run(PROJECT_ID, 'admin');

        expect(receipt.snapshots).toMatchObject({ state: 'deleted', blobs: 2, snapshots: 2, removed: 2 });
        expect(remove).toHaveBeenCalledTimes(2);
        expect(state.blobs).toEqual([]);
        for (const table of metadataTables.filter((table) => table !== 'project_snapshot_blobs')) {
            expect(state.deletes).toContain(`DELETE FROM ${table} WHERE project_id=$1`);
        }
    });

    it('снимки: неподтверждённое удаление блока оставляет строки, состояние pending', async () => {
        const remove = vi.fn(async (_project: string, sha: string) => {
            if (sha === 'c'.repeat(64)) throw new Error('S3 отказался подтвердить');
        });
        const { state, pool } = cascadeFixture({
            tables: ['project_snapshot_blobs', 'project_snapshots'],
            blobs: [blob(), blob({ sha256: 'c'.repeat(64) })],
            snapshots: 2,
        });
        const { service } = makeService(pool, { backupDir, snapshotStorage: { remove } });
        const receipt = await service.run(PROJECT_ID, 'admin');

        expect(receipt.snapshots).toMatchObject({ state: 'pending', removed: 1, remaining: 1 });
        expect(state.blobs).toHaveLength(1);
        expect(state.blobs[0].sha256).toBe('c'.repeat(64));
        expect(state.blobs[0].state).toBe('DELETING');
        expect(state.deletes).toEqual([]);
    });

    it('скиллы: 404 — absent, 500 — failed, пустой каталог — absent', async () => {
        for (const [skillsResponse, expected] of [
            [jsonResponse(null, 404), 'absent'],
            [jsonResponse({}, 500), 'failed'],
            [jsonResponse({ deleted: false, skills: 0 }), 'absent'],
        ] as const) {
            const { pool } = cascadeFixture();
            const { service } = makeService(pool, {
                backupDir,
                skillsFetch: vi.fn(async () => skillsResponse),
            });
            const receipt = await service.run(PROJECT_ID, 'admin');
            expect(receipt.skills?.state).toBe(expected);
        }
    });

    it('одновременный run для одного проекта: домены выполняются один раз', async () => {
        const { pool } = cascadeFixture();
        let resolveRag!: (value: { state: string }) => void;
        const { service } = makeService(pool, {
            backupDir,
            rag: vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveRag = resolve;
                    }),
            ),
        });
        const first = service.run(PROJECT_ID, 'admin');
        const second = service.run(PROJECT_ID, 'admin');
        const secondReceipt = await second;
        expect(secondReceipt).toEqual({});
        await new Promise((resolve) => setImmediate(resolve));
        expect(resolveRag).toBeTypeOf('function');
        resolveRag({ state: 'deleted' });
        const firstReceipt = await first;
        expect(firstReceipt.rag?.state).toBe('deleted');
    });

    it('предикаты квитанции: терминальные состояния и незакрытые домены', () => {
        expect(isTerminalDeletion('deleted')).toBe(true);
        expect(isTerminalDeletion('absent')).toBe(true);
        expect(isTerminalDeletion('pending')).toBe(false);
        expect(isTerminalDeletion('failed')).toBe(false);
        expect(isTerminalDeletion(undefined)).toBe(false);
        expect(hasOpenDeletion({ rag: { state: 'failed', at: 't' } })).toBe(true);
        expect(hasOpenDeletion({ rag: { state: 'pending', at: 't' }, chat: { state: 'deleted', at: 't' } })).toBe(true);
        expect(hasOpenDeletion({})).toBe(false);
        const closed: TDeletionReceipt = {};
        for (const domain of DELETION_DOMAINS) closed[domain] = { state: 'deleted', at: 't' };
        expect(hasOpenDeletion(closed)).toBe(false);
    });
});
