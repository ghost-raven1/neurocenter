import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ResolvedAsset, ToolAsset } from '@neurocenter/asset-contract';
import { toToolPublication } from '@neurocenter/asset-contract';
import { actor, databaseFixture, tool } from './asset-import-db.fixture';
import { ToolAssetAdapter } from '../src/asset-sources/tool-adapter';
import type { AssetImportWorker } from '../src/asset-sources/import-worker';

vi.mock('../src/features/require-feature-enabled', () => ({
    requireFeaturesEnabled: vi.fn(async () => undefined),
    requireFeatureEnabled: vi.fn(async () => undefined),
}));

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.sequential('Asset import cancellation — actual PostgreSQL commit boundaries', () => {
    let f: Awaited<ReturnType<typeof databaseFixture>>;
    let dispose: (() => Promise<void>) | undefined;
    let workers: AssetImportWorker[] = [];
    let unblock: Array<() => void | Promise<void>> = [];

    beforeEach(async () => {
        workers = []; unblock = []; dispose = undefined;
        f = await databaseFixture(); dispose = f.dispose;
    }, 60_000);
    afterEach(async () => {
        for (const release of unblock.reverse()) await release();
        await Promise.all(workers.map(worker => worker.stop()));
        vi.restoreAllMocks();
        const cleanup = dispose; dispose = undefined; await cleanup?.();
    }, 60_000);

    function barrier() {
        const entered = deferred(), release = deferred();
        unblock.push(release.resolve);
        return { entered, release };
    }
    function run() {
        const worker = f.worker(); workers.push(worker);
        return worker.flush();
    }
    async function begin(records: ResolvedAsset[] = [tool('tool-a')]) {
        return f.jobs.create(actor, randomUUID(), await f.snapshot(records), records.map(record => record.asset.id));
    }
    /** A failed worker cannot leave the test waiting forever for a barrier it never reached. */
    async function reached(entered: ReturnType<typeof deferred>, running: Promise<void>) {
        await Promise.race([entered.promise, running.then(() => { throw new Error('Worker finished before the controlled cancellation boundary'); })]);
    }
    async function nativeRows() {
        return (await f.pool.query('SELECT id,name,version FROM ai_plugins ORDER BY name')).rows;
    }

    it('a late conflict plan cannot resurrect a cancellation acknowledged while prepare was pending', async () => {
        const publication = toToolPublication(tool('tool-a').asset as ToolAsset);
        const local = await f.plugins.create({ ...publication, description: 'Local content that must be preserved' }, actor);
        const localHistory = await f.plugins.versions(local.id);
        const job = await begin(), gate = barrier();
        const preview = ToolAssetAdapter.prototype.preview;
        vi.spyOn(ToolAssetAdapter.prototype, 'preview').mockImplementationOnce(async function (this: ToolAssetAdapter, ...args: Parameters<ToolAssetAdapter['preview']>) {
            const item = await preview.call(this, ...args);
            expect(item.action).toBe('conflict');
            gate.entered.resolve(); await gate.release.promise;
            return item;
        });
        const running = run();
        let acknowledged: Awaited<ReturnType<typeof f.jobs.cancel>>;
        try {
            await reached(gate.entered, running);
            expect((await f.jobs.get(job.id)).state).toBe('QUEUED');
            acknowledged = await f.jobs.cancel(job.id, actor);
            expect(acknowledged).toMatchObject({ state: 'CANCELLED', cancel_requested: true, items: [] });
        } finally { gate.release.resolve(); await running; }

        expect(await f.jobs.get(job.id)).toEqual(acknowledged!);
        expect(await f.plugins.get(local.id)).toEqual(local);
        expect(await f.plugins.versions(local.id)).toEqual(localHistory);
        expect(await f.jobs.versions(job.source.repository)).toEqual([]);
        expect(await f.jobs.receipts(job.source.repository)).toEqual([]);
    }, 60_000);

    it.each([true, false])('cancel=%s while blocked on the real native lock respects the acknowledged order', async cancel => {
        const job = await begin(), gate = barrier(), holder = await f.pool.connect();
        const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        let locked = false, released = false;
        const releaseHolder = async () => {
            if (released) return; released = true;
            try { if (locked) await holder.query('COMMIT'); } finally { holder.release(); }
        };
        unblock.push(releaseHolder);
        const supply = f.blobs.importAsset.bind(f.blobs);
        vi.spyOn(f.blobs, 'importAsset').mockImplementationOnce(async (...args) => {
            const blobs = await supply(...args), current = await f.jobs.get(job.id);
            await holder.query('BEGIN');
            await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['asset-management:plugin:' + current.items[0].native!.id]);
            locked = true; gate.entered.resolve();
            return blobs;
        });
        const running = run();
        try {
            await reached(gate.entered, running);
            // Observe the actual PostgreSQL waiter; cancellation must arrive after the worker's pre-lock check.
            await vi.waitFor(async () => {
                const waiting = await f.pool.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))', [holderPid]);
                expect(waiting.rows).toHaveLength(1);
                expect(waiting.rows[0].pid).not.toBe(holderPid);
            }, { timeout: 5_000, interval: 20 });
            expect((await f.jobs.get(job.id)).cancel_requested).toBe(false);
            if (cancel) {
                const acknowledged = await f.jobs.cancel(job.id, actor);
                expect(acknowledged.cancel_requested).toBe(true);
                expect((await f.jobs.get(job.id)).cancel_requested).toBe(true);
            }
        } finally { await releaseHolder(); gate.release.resolve(); await running; }

        const saved = await f.jobs.get(job.id);
        expect(saved.state, saved.message).toBe(cancel ? 'CANCELLED' : 'SUCCEEDED');
        expect(saved.cancel_requested).toBe(cancel);
        expect(await nativeRows()).toHaveLength(cancel ? 0 : 1);
        expect((await f.pool.query('SELECT * FROM ai_plugin_versions')).rows).toHaveLength(cancel ? 0 : 1);
        expect(await f.jobs.versions(job.source.repository)).toHaveLength(cancel ? 0 : 1);
        expect(await f.jobs.receipts(job.source.repository)).toHaveLength(cancel ? 0 : 1);
        if (cancel) expect(saved.items.some(item => item.state === 'SUCCEEDED')).toBe(false);
    }, 60_000);

    it('cancellation before the second publication preserves the first committed card, history and source receipt', async () => {
        const job = await begin([tool('tool-a'), tool('tool-b')]), gate = barrier();
        const supply = f.blobs.importAsset.bind(f.blobs);
        vi.spyOn(f.blobs, 'importAsset').mockImplementation(async (...args) => {
            const blobs = await supply(...args);
            if (args[0].id === 'tool-b') { gate.entered.resolve(); await gate.release.promise; }
            return blobs;
        });
        const running = run();
        let first: Awaited<ReturnType<typeof f.plugins.get>>;
        let history: Awaited<ReturnType<typeof f.plugins.versions>>;
        let versions: Awaited<ReturnType<typeof f.jobs.versions>>;
        let receipts: Awaited<ReturnType<typeof f.jobs.receipts>>;
        try {
            await reached(gate.entered, running);
            // Independent pool reads see the first item only after its native publication and receipt COMMIT.
            const durable = await f.jobs.get(job.id);
            expect(durable.items[0]).toMatchObject({ resolved: { asset: { id: 'tool-a' } }, state: 'SUCCEEDED' });
            first = await f.plugins.get('tool-a'); expect(first).toMatchObject({ version: 1 });
            history = await f.plugins.versions(first!.id);
            versions = await f.jobs.versions(job.source.repository);
            receipts = await f.jobs.receipts(job.source.repository);
            expect(versions).toHaveLength(1); expect(receipts).toHaveLength(1);
            expect(await f.plugins.get('tool-b')).toBeNull();
            expect((await f.jobs.cancel(job.id, actor)).cancel_requested).toBe(true);
        } finally { gate.release.resolve(); await running; }

        const saved = await f.jobs.get(job.id);
        expect(saved).toMatchObject({ state: 'CANCELLED', cancel_requested: true });
        expect(saved.items.find(item => item.resolved.asset.id === 'tool-a')?.state).toBe('SUCCEEDED');
        expect(saved.items.find(item => item.resolved.asset.id === 'tool-b')?.state).not.toBe('SUCCEEDED');
        expect(await f.plugins.get(first!.id)).toEqual(first!);
        expect(await f.plugins.versions(first!.id)).toEqual(history!);
        expect(await f.jobs.versions(job.source.repository)).toEqual(versions!);
        expect(await f.jobs.receipts(job.source.repository)).toEqual(receipts!);
        expect(await f.plugins.get('tool-b')).toBeNull();
        expect(await nativeRows()).toHaveLength(1);
        expect((await f.pool.query('SELECT * FROM ai_plugin_versions')).rows).toHaveLength(1);
    }, 60_000);

    it('cancellation after the final check cannot acknowledge before the native publication transaction commits', async () => {
        const job = await begin(), gate = barrier(), receipt = f.jobs.receipt.bind(f.jobs);
        let publisherPid = 0;
        vi.spyOn(f.jobs, 'receipt').mockImplementationOnce(async (...args) => {
            await receipt(...args);
            publisherPid = (await args[0].query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            gate.entered.resolve(); await gate.release.promise;
        });
        const running = run();
        let settled = false;
        let cancelling: ReturnType<typeof f.jobs.cancel> | undefined;
        let acknowledged: Awaited<ReturnType<typeof f.jobs.cancel>> | undefined;
        try {
            await reached(gate.entered, running);
            expect(publisherPid).toBeGreaterThan(0);
            // Native and source rows exist inside the paused transaction but are invisible to another session.
            expect(await nativeRows()).toEqual([]);
            expect(await f.jobs.versions(job.source.repository)).toEqual([]);
            cancelling = f.jobs.cancel(job.id, actor).then(value => { settled = true; return value; });
            await vi.waitFor(async () => {
                const waiting = await f.pool.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))', [publisherPid]);
                expect(waiting.rows).toHaveLength(1);
                expect(waiting.rows[0].pid).not.toBe(publisherPid);
                expect(settled).toBe(false);
            }, { timeout: 5_000, interval: 20 });
            expect(settled).toBe(false);
            expect((await f.jobs.get(job.id)).cancel_requested).toBe(false);
        } finally {
            gate.release.resolve();
            const completed = await Promise.all([running, cancelling]);
            acknowledged = completed[1];
        }

        expect(acknowledged?.id).toBe(job.id);
        expect(acknowledged?.items[0]).toMatchObject({ state: 'SUCCEEDED', native: { version: 1 } });
        const committed = (await f.plugins.get('tool-a'))!;
        expect(committed).toMatchObject({ id: acknowledged!.items[0].native!.id, version: 1 });
        expect(await nativeRows()).toHaveLength(1);
        expect(await f.plugins.versions(committed.id)).toHaveLength(1);
        const versions = await f.jobs.versions(job.source.repository);
        expect(versions).toHaveLength(1);
        expect(versions[0]).toMatchObject({
            native_id: committed.id, native_version: 1,
            native_hash: acknowledged!.items[0].native!.hash, native_manifest: acknowledged!.items[0].native!.manifest,
        });
        expect(await f.jobs.receipts(job.source.repository)).toHaveLength(1);
        expect((await f.jobs.get(job.id)).items[0]).toMatchObject({ state: 'SUCCEEDED', native: acknowledged!.items[0].native });
    }, 60_000);
});
