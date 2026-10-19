import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRagBridgeJob } from '../src/bridge/rag-worker.js';
import { projectBindingId } from '../src/bridge/workspace.js';
import { indexSnapshotHash } from '../src/features/rag-index/contract.js';
import { writeRows } from '../src/lib/lancedb.js';
import { syncRagDb } from '../src/tools/sync-rag-db.js';
import { workspaceFixture } from './bridge-fixture.js';
import { metadata, profile, readyIndex, row } from './rag-index-fixture.js';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/bridge/state.js', async original => ({
    ...await original<typeof import('../src/bridge/state.js')>(), authorizedFetch: transport.fetch,
}));

type Chunk = ReturnType<typeof row>;
interface SyncBody {
    projectKey: string;
    fingerprintVersion: number;
    indexProfile: typeof profile;
    snapshot: { hash: string; rowCount: number; complete: boolean };
    chunks: Chunk[];
    deletes: string[];
}
const ROW_COUNT = 1201;

describe('Большой настоящий LanceDB-индекс проходит через мост без ручного плана MCP', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    let job: { kind: 'sync-rag'; projectId: string; bindingId: string };
    let server: Map<string, Chunk>;
    let requests: SyncBody[];
    let complete: boolean;
    let failAt: number | undefined;
    let manifests: number;
    const authorize = vi.fn<() => Promise<void>>();
    const update = vi.fn<(percent: number, message: string) => Promise<void>>();

    beforeEach(async () => {
        fixture = await workspaceFixture();
        await readyIndex(fixture.root);
        await writeRows(path.join(fixture.root, '.opencode/rag_db'),
            Array.from({ length: ROW_COUNT }, (_, index) => row(`chunk-${String(index).padStart(4, '0')}`)), false, 3);
        job = { kind: 'sync-rag', projectId: 'test-project', bindingId: await projectBindingId('test-project') };
        server = new Map(); requests = []; complete = false; failAt = undefined; manifests = 0;
        authorize.mockReset().mockResolvedValue(undefined); update.mockReset().mockResolvedValue(undefined);
        transport.fetch.mockReset().mockImplementation(async (route: string, options?: RequestInit) => {
            if (!options) {
                expect(route).toBe('/api/rag/manifest?projectKey=test-project'); manifests++;
                return Response.json(metadata([...server.values()], complete));
            }
            expect(route).toBe('/api/rag/sync'); expect(options.method).toBe('POST');
            const body = JSON.parse(String(options.body)) as SyncBody; requests.push(body);
            expect(body.projectKey).toBe(job.projectId); expect(body.fingerprintVersion).toBe(1);
            expect(body.indexProfile).toEqual(profile); expect(body.snapshot.rowCount).toBe(ROW_COUNT);
            expect(body.chunks.length + body.deletes.length).toBeLessThanOrEqual(100);
            if (requests.length === failAt) { return Response.json({ message: 'Временный отказ тестового хранилища' }, { status: 503 }); }
            if (body.snapshot.complete) {
                expect(body.chunks).toEqual([]); expect(body.deletes).toEqual([]);
                expect(server.size).toBe(body.snapshot.rowCount);
                expect(indexSnapshotHash(profile, metadata([...server.values()]).fingerprints)).toBe(body.snapshot.hash);
                complete = true;
            } else {
                complete = false;
                for (const chunk of body.chunks) { expect(path.isAbsolute(chunk.filePath)).toBe(false); server.set(chunk.id, chunk); }
                for (const id of body.deletes) { server.delete(id); }
            }
            return Response.json({ upserted: body.chunks.length, deleted: body.deletes.length,
                complete, snapshotHash: complete ? body.snapshot.hash : null });
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks(); vi.unstubAllEnvs();
        await fs.rm(fixture.temporary, { recursive: true, force: true });
    });

    it('1201 фрагмент передаётся за три прохода по 500 и повтор не загружает их заново', async () => {
        // Ручной MCP сохраняет защитный preview, а веб-задание само применяет ограниченные порции.
        expect(JSON.parse(await syncRagDb({ project: fixture.root }, fixture.root))).toMatchObject({ applied: false, remaining: ROW_COUNT });
        expect(requests).toEqual([]); manifests = 0;
        const result = await runRagBridgeJob(job, authorize, update);
        expect(result).toMatchObject({ ok: true, applied: true, complete: true, remaining: 0,
            localCount: ROW_COUNT, upserted: ROW_COUNT, deleted: 0, appliedNow: ROW_COUNT, batches: 3, bindingId: job.bindingId });
        expect(manifests).toBe(3); expect(server.size).toBe(ROW_COUNT); expect(complete).toBe(true);
        expect(requests.map(body => body.chunks.length)).toEqual([...Array<number>(12).fill(100), 1, 0]);
        expect(requests.filter(body => body.snapshot.complete)).toHaveLength(1);
        expect(update.mock.calls.map(([percent]) => percent)).toEqual([39, 79, 99]);
        expect(update.mock.calls.map(([, message]) => message)).toEqual([
            'Передано изменений: 500. Осталось: 701.', 'Передано изменений: 1000. Осталось: 201.',
            'Полный индекс проверен, сохраняем результат.',
        ]);

        requests = []; manifests = 0; update.mockClear();
        expect(await runRagBridgeJob(job, authorize, update)).toMatchObject({ complete: true, remaining: 0,
            upserted: 0, deleted: 0, appliedNow: 0, batches: 1, snapshotHash: result.snapshotHash });
        expect(manifests).toBe(1); expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ chunks: [], deletes: [], snapshot: { complete: true } });
    }, 30_000);

    it('Отказ после 700 принятых строк сохраняет прогресс; повтор догружает 501 и только затем удаляет устаревшую', async () => {
        server.set('obsolete', row('obsolete')); failAt = 8;
        await expect(runRagBridgeJob(job, authorize, update)).rejects.toThrow('HTTP 503');
        expect(server.size).toBe(701); expect(server.has('obsolete')).toBe(true); expect(complete).toBe(false);
        expect(requests.filter(body => body.snapshot.complete)).toEqual([]);
        expect(requests.flatMap(body => body.deletes)).toEqual([]);
        expect(update.mock.calls.map(([, message]) => message)).toEqual(['Передано изменений: 500. Осталось: 702.']);
        const previouslyAccepted = new Set([...server.keys()].filter(id => id !== 'obsolete'));

        failAt = undefined; requests = []; manifests = 0; update.mockClear();
        expect(await runRagBridgeJob(job, authorize, update)).toMatchObject({ ok: true, complete: true, remaining: 0,
            upserted: 501, deleted: 1, appliedNow: 502, batches: 2 });
        expect(manifests).toBe(2); expect(server.size).toBe(ROW_COUNT); expect(server.has('obsolete')).toBe(false);
        expect(complete).toBe(true);
        const resent = requests.flatMap(body => body.chunks.map(chunk => chunk.id));
        expect(resent).toHaveLength(501); expect(resent.some(id => previouslyAccepted.has(id))).toBe(false);
        expect(requests.map(body => [body.chunks.length, body.deletes.length, body.snapshot.complete])).toEqual([
            ...Array.from({ length: 5 }, () => [100, 0, false]), [1, 0, false], [0, 1, false], [0, 0, true],
        ]);
        expect(update.mock.calls.map(([, message]) => message)).toEqual([
            'Передано изменений: 500. Осталось: 2.', 'Полный индекс проверен, сохраняем результат.',
        ]);
    }, 30_000);
});
