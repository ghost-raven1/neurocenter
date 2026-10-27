import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { assetDigest, serializeAsset, type ResolvedAsset, type ToolAsset } from '@neurocenter/asset-contract';
import { actor, databaseFixture, tool } from './asset-import-db.fixture';
import { ProjectAssetRepository } from '../src/catalog/project-asset-repository';
import { captureProjectAsset } from '../src/catalog/project-asset-pins';
import { listAuditHistory } from '../src/catalog/audit-history';
import { assetCardState, sourceAssetView } from '../src/asset-sources/asset-source-view';
import { plannedToolCard, ToolAssetAdapter } from '../src/asset-sources/tool-adapter';
import { nativeCardHash } from '../src/publication/native-hash';
import { importView } from '../src/asset-sources/import-types';
import type { IPackage } from '../src/catalog/bundle-package';
import type { IAiPlugin } from '../src/catalog/dto';

// Only the external feature service is excluded; publication, worker and SQL are real.
vi.mock('../src/features/require-feature-enabled', () => ({
    requireFeaturesEnabled: vi.fn(async () => undefined),
    requireFeatureEnabled: vi.fn(async () => undefined),
}));

/** A package read may receive a fresh display timestamp; its executable bytes and SHA must remain exact. */
function packageBytes(pkg: IPackage): string {
    return JSON.stringify({ ...pkg, manifest: { ...pkg.manifest, createdAt: '' } });
}

/** Source title and executable content change together while the external ID stays fixed. */
function renamedTool(version = '2.0.0', name = 'Source renamed tool'): ResolvedAsset {
    const resolved = tool('tool-a', version);
    const asset = resolved.asset as ToolAsset;
    asset.card.name = name;
    asset.card.files[0].content = `export const fixture = async () => ({ sourceVersion: '${version}' })`;
    resolved.sha256 = assetDigest(serializeAsset(asset));
    return resolved;
}

describe('Source tool rename — real PostgreSQL, stable installation identity', () => {
    let f: Awaited<ReturnType<typeof databaseFixture>>;
    let dispose: (() => Promise<void>) | undefined;
    beforeEach(async () => { dispose = undefined; f = await databaseFixture(); dispose = f.dispose; }, 60_000);
    afterEach(async () => {
        vi.restoreAllMocks();
        const cleanup = dispose; dispose = undefined; await cleanup?.();
    }, 60_000);

    async function importSource(input: ResolvedAsset | ResolvedAsset[], commit: string, selectedIds?: string[]) {
        const records = Array.isArray(input) ? input : [input];
        const source = await f.snapshot(records, commit);
        const job = await f.jobs.create(actor, randomUUID(), source, selectedIds ?? records.filter(record => record.current).map(record => record.asset.id));
        const worker = f.worker();
        try { await worker.flush(); } finally { await worker.stop(); }
        return f.jobs.get(job.id);
    }

    async function assignCurrent(id: string) {
        await f.pool.query("INSERT INTO projects(id,name) VALUES('rename-project','Rename project')");
        await new ProjectAssetRepository(f.pool).add('rename-project', id, 'plugin', actor);
        return (await f.pool.query("SELECT * FROM project_assets WHERE project_id='rename-project'")).rows[0];
    }

    it.each([
        { label: 'version, contents and source name change', rename: true, contents: true, nativeVersion: 2 },
        { label: 'only source name changes', rename: true, contents: false, nativeVersion: 1 },
        { label: 'contents change without rename (positive control)', rename: false, contents: true, nativeVersion: 2 },
    ])('$label: succeeds, preserves history/pin and repeats without a new native version', async scenario => {
        const original = tool('tool-a');
        const oldAsset = original.asset as ToolAsset;
        const first = await importSource(original, 'a'.repeat(40));
        expect(first.state, first.message).toBe('SUCCEEDED');
        const before = (await f.plugins.get('tool-a'))!;
        expect(before).toMatchObject({ name: 'tool-a', version: 1 });
        const firstSourceVersion = (await f.jobs.versions(f.pin.repository))[0];
        expect(firstSourceVersion).toMatchObject({
            external_id: 'tool-a', asset_version: '1.0.0', descriptor_sha256: original.sha256,
            native_id: before.id, native_version: 1, native_hash: nativeCardHash(before),
        });
        const historyBefore = (await f.plugins.version(before.id, 1))!;
        const packageBefore = (await captureProjectAsset(f.pool, before.id, 'plugin', 1)).package;
        expect(packageBefore.manifest.sha256).toBe(firstSourceVersion.native_manifest);
        await f.pool.query("INSERT INTO projects(id,name) VALUES('rename-project','Rename project')");
        const assignments = new ProjectAssetRepository(f.pool);
        await assignments.add('rename-project', before.id, 'plugin', actor);
        const projectPinBefore = (await f.pool.query("SELECT * FROM project_assets WHERE project_id='rename-project'")).rows[0];
        expect(projectPinBefore).toMatchObject({ asset_id: before.id, asset_version: 1, asset_manifest: packageBefore.manifest.sha256 });

        const next = structuredClone(original);
        const nextAsset = next.asset as ToolAsset;
        nextAsset.version = '2.0.0';
        next.path = 'assets/tool-a/2.0.0/asset.json';
        if (scenario.rename) nextAsset.card.name = 'Source renamed tool';
        if (scenario.contents) {
            nextAsset.card.description = 'New source contents';
            nextAsset.card.revision = '2.0.0';
            nextAsset.card.files[0].content = 'export const fixture = async () => ({ sourceVersion: 2 })';
        } else {
            expect({ ...nextAsset.card, name: oldAsset.card.name }).toEqual(oldAsset.card);
        }
        next.sha256 = assetDigest(serializeAsset(nextAsset));

        const updated = await importSource(next, 'b'.repeat(40));
        expect(updated.state, updated.message).toBe('SUCCEEDED');
        expect(updated.items[0].action).toBe(scenario.contents ? 'update' : 'unchanged');
        expect(importView(updated).items[0]).toMatchObject({
            name: nextAsset.card.name,
            ...(scenario.rename ? { catalogName: before.name } : {}),
        });
        const head = (await f.plugins.get(before.id))!;
        expect(head).toMatchObject({
            id: before.id, name: before.name, version: scenario.nativeVersion,
            description: nextAsset.card.description, revision: nextAsset.card.revision,
            files: nextAsset.card.files, config: nextAsset.card.config,
        });
        expect((await f.pool.query('SELECT id FROM ai_plugins')).rows).toEqual([{ id: before.id }]);
        if (!scenario.contents) expect(head).toEqual(before);

        const versions = await f.jobs.versions(f.pin.repository);
        expect(versions).toHaveLength(2);
        expect(versions.find(row => row.asset_version === '1.0.0')).toEqual(firstSourceVersion);
        const sourceVersion = versions.find(row => row.asset_version === '2.0.0')!;
        const latestPackage = (await captureProjectAsset(f.pool, before.id, 'plugin')).package;
        expect(sourceVersion).toMatchObject({
            external_id: 'tool-a', asset_version: '2.0.0', descriptor_sha256: next.sha256,
            source_commit: 'b'.repeat(40), native_id: before.id, native_version: scenario.nativeVersion,
            native_hash: nativeCardHash(head), native_manifest: latestPackage.manifest.sha256,
            descriptor: { card: { name: nextAsset.card.name } },
        });
        const receipts = await f.jobs.receipts(f.pin.repository);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({
            external_id: 'tool-a', asset_version: '2.0.0', descriptor_sha256: next.sha256,
            native_id: before.id, native_version: scenario.nativeVersion, native_hash: nativeCardHash(head),
            descriptor: { card: { name: nextAsset.card.name } },
        });
        expect(sourceAssetView(nextAsset, next.sha256, receipts[0], await assetCardState(f.pool, receipts[0])))
            .toMatchObject({ name: nextAsset.card.name, imported: { name: before.name, originVersion: '2.0.0', updateAvailable: false } });
        const audit = await listAuditHistory(f.pool, 1, 100);
        expect(audit.items.find(event => event.action === 'asset.import.request' && event.resourceId === updated.id))
            .toMatchObject({ details: { after: { items: [{ assetId: 'tool-a', name: nextAsset.card.name, version: '2.0.0' }] } } });
        expect(audit.items.find(event => event.action === 'asset.import.request' && event.resourceId === first.id))
            .toMatchObject({ details: { after: { items: [{ assetId: 'tool-a', name: before.name, version: '1.0.0' }] } } });

        const historyAfter = (await f.plugins.version(before.id, 1))!;
        expect(historyAfter).toEqual(historyBefore);
        const historicalPackage = (await captureProjectAsset(f.pool, before.id, 'plugin', 1)).package;
        expect(packageBytes(historicalPackage)).toBe(packageBytes(packageBefore));
        expect((await f.pool.query("SELECT * FROM project_assets WHERE project_id='rename-project'")).rows[0]).toEqual(projectPinBefore);
        expect((await assignments.catalog('rename-project'))[0]).toMatchObject({
            assetId: before.id, version: 1, manifest: packageBefore.manifest.sha256,
            card: { name: before.name, version: 1, files: before.files },
        });

        const nativeHistory = await f.plugins.versions(before.id);
        expect(nativeHistory).toHaveLength(scenario.nativeVersion);
        const repeated = await importSource(next, 'b'.repeat(40));
        expect(repeated.state, repeated.message).toBe('SUCCEEDED');
        expect(repeated.items[0].action).toBe('unchanged');
        expect(await f.plugins.get(before.id)).toEqual(head);
        expect(await f.plugins.versions(before.id)).toEqual(nativeHistory);
        expect(await f.jobs.versions(f.pin.repository)).toEqual(versions);
        expect(await f.jobs.receipts(f.pin.repository)).toEqual(receipts);
        expect((await f.pool.query("SELECT * FROM project_assets WHERE project_id='rename-project'")).rows[0]).toEqual(projectPinBefore);
    });

    it('a dependency on the old source version survives a later source rename and preserves the project package', async () => {
        const old = tool('tool-a');
        const first = await importSource(old, 'a'.repeat(40));
        expect(first.state, first.message).toBe('SUCCEEDED');
        const nativeId = first.items[0].native!.id;
        const oldVersion = (await f.jobs.versions(f.pin.repository))[0];
        const oldHistory = await f.plugins.version(nativeId, 1);
        const oldPackage = (await captureProjectAsset(f.pool, nativeId, 'plugin', 1)).package;
        const pin = await assignCurrent(nativeId);
        const next = renamedTool();
        const updated = await importSource(next, 'b'.repeat(40));
        expect(updated.state, updated.message).toBe('SUCCEEDED');
        const head = await f.plugins.get(nativeId);
        const history = await f.plugins.versions(nativeId);
        const historical = { ...old, current: false };
        const root = tool('dependent-a', '1.0.0', [{ id: old.asset.id, version: old.asset.version, sha256: old.sha256 }]);

        const imported = await importSource([historical, next, root], 'c'.repeat(40), [root.asset.id]);
        expect(imported.state, imported.message).toBe('SUCCEEDED');
        expect(imported.items.find(item => item.resolved.asset.id === 'tool-a')).toMatchObject({
            action: 'unchanged', native: { id: nativeId, version: 1, manifest: oldPackage.manifest.sha256 },
        });
        expect((await f.plugins.get('dependent-a'))?.dependencies).toEqual([
            { kind: 'plugin', id: nativeId, version: 1, manifest: oldPackage.manifest.sha256 },
        ]);
        expect(await f.plugins.get(nativeId)).toEqual(head);
        expect(await f.plugins.versions(nativeId)).toEqual(history);
        expect(await f.plugins.version(nativeId, 1)).toEqual(oldHistory);
        expect((await f.jobs.versions(f.pin.repository)).find(row => row.external_id === 'tool-a' && row.asset_version === '1.0.0')).toEqual(oldVersion);
        expect(packageBytes((await captureProjectAsset(f.pool, nativeId, 'plugin', 1)).package)).toBe(packageBytes(oldPackage));
        expect((await f.pool.query("SELECT * FROM project_assets WHERE project_id='rename-project'")).rows[0]).toEqual(pin);
        const repeated = await importSource([historical, next, root], 'c'.repeat(40), [root.asset.id]);
        expect(repeated.state, repeated.message).toBe('SUCCEEDED');
        expect(repeated.items.every(item => item.action === 'unchanged')).toBe(true);
        expect(await f.plugins.versions(nativeId)).toEqual(history);
        expect(await f.plugins.versions(imported.items.find(item => item.resolved.asset.id === root.asset.id)!.native!.id)).toHaveLength(1);
    });

    it('first materialization of a historical source name writes a snapshot without renaming or advancing the current head', async () => {
        const historical = { ...tool('tool-a'), current: false };
        const next = renamedTool('2.0.0', 'Source v2 title');
        const first = await importSource([historical, next], 'a'.repeat(40), ['tool-a']);
        expect(first.state, first.message).toBe('SUCCEEDED');
        const nativeId = first.items[0].native!.id;
        const head = (await f.plugins.get(nativeId))!;
        expect(head).toMatchObject({ name: 'Source v2 title', version: 1 });
        const currentVersion = (await f.jobs.versions(f.pin.repository))[0];
        const currentReceipt = (await f.jobs.receipts(f.pin.repository))[0];
        const currentHistory = await f.plugins.version(nativeId, 1);
        const currentPackage = (await captureProjectAsset(f.pool, nativeId, 'plugin')).package;
        const projectPin = await assignCurrent(nativeId);
        const root = tool('historical-dependent', '1.0.0', [{ id: historical.asset.id, version: historical.asset.version, sha256: historical.sha256 }]);

        const imported = await importSource([historical, next, root], 'b'.repeat(40), [root.asset.id]);
        expect(imported.state, imported.message).toBe('SUCCEEDED');
        const oldPackage = await captureProjectAsset(f.pool, nativeId, 'plugin', 2);
        expect(oldPackage.package.plugin).toMatchObject({ id: nativeId, name: head.name, version: 2 });
        expect(oldPackage.package.files[0].content).toBe((historical.asset as ToolAsset).card.files[0].content);
        expect(imported.items.find(item => item.resolved.asset.id === 'tool-a')).toMatchObject({
            action: 'snapshot', native: { id: nativeId, version: 2, manifest: oldPackage.package.manifest.sha256 },
        });
        expect((await f.plugins.get(root.asset.id))?.dependencies).toEqual([
            { kind: 'plugin', id: nativeId, version: 2, manifest: oldPackage.package.manifest.sha256 },
        ]);
        const versions = await f.jobs.versions(f.pin.repository);
        // The project view renders an empty dependency array; the native CAS omits an empty set.
        const { dependencies, ...historicalCard } = oldPackage.card;
        const historicalHash = nativeCardHash({ ...historicalCard,
            ...(Array.isArray(dependencies) && dependencies.length ? { dependencies } : {}),
        } as unknown as IAiPlugin);
        expect(versions.find(row => row.external_id === 'tool-a' && row.asset_version === '1.0.0')).toMatchObject({
            descriptor_sha256: historical.sha256, native_id: nativeId, native_version: 2,
            native_hash: historicalHash, native_manifest: oldPackage.package.manifest.sha256,
            descriptor: { card: { name: 'tool-a' } },
        });
        expect(versions.find(row => row.external_id === 'tool-a' && row.asset_version === '2.0.0')).toEqual(currentVersion);
        expect((await f.jobs.receipts(f.pin.repository)).find(row => row.external_id === 'tool-a')).toEqual(currentReceipt);
        expect(await f.plugins.get(nativeId)).toEqual(head);
        expect(await f.plugins.version(nativeId, 1)).toEqual(currentHistory);
        expect(packageBytes((await captureProjectAsset(f.pool, nativeId, 'plugin')).package)).toBe(packageBytes(currentPackage));
        expect((await f.pool.query("SELECT * FROM project_assets WHERE project_id='rename-project'")).rows[0]).toEqual(projectPin);
        const nativeHistory = await f.plugins.versions(nativeId);
        expect(nativeHistory.map(row => row.version)).toEqual([2, 1]);
        const repeated = await importSource([historical, next, root], 'b'.repeat(40), [root.asset.id]);
        expect(repeated.state, repeated.message).toBe('SUCCEEDED');
        expect(repeated.items.every(item => item.action === 'unchanged')).toBe(true);
        expect(await f.plugins.versions(nativeId)).toEqual(nativeHistory);
        expect(await f.jobs.versions(f.pin.repository)).toEqual(versions);
    });

    it('source title equal to another selected tool does not collide with their distinct native installation names', async () => {
        const first = await importSource([tool('tool-a'), tool('tool-b')], 'a'.repeat(40));
        expect(first.state, first.message).toBe('SUCCEEDED');
        const a = (await f.plugins.get('tool-a'))!;
        const b = (await f.plugins.get('tool-b'))!;
        const renamed = renamedTool('2.0.0', 'tool-b');
        const updated = await importSource([renamed, tool('tool-b')], 'b'.repeat(40));
        expect(updated.state, updated.message).toBe('SUCCEEDED');
        expect((await f.plugins.get(a.id))).toMatchObject({ id: a.id, name: 'tool-a', version: 2, files: (renamed.asset as ToolAsset).card.files });
        expect(await f.plugins.get(b.id)).toEqual(b);
        expect(a.id).not.toBe(b.id);
        expect((await f.pool.query('SELECT id,name FROM ai_plugins ORDER BY name')).rows).toEqual([{ id: a.id, name: 'tool-a' }, { id: b.id, name: 'tool-b' }]);
        expect(importView(updated).items.find(item => item.id === 'tool-a')).toMatchObject({ name: 'tool-b', catalogName: 'tool-a', native: { id: a.id } });
        expect(importView(updated).items.find(item => item.id === 'tool-b')).not.toHaveProperty('catalogName');
        const audit = await listAuditHistory(f.pool, 1, 100);
        expect(audit.items.find(event => event.action === 'asset.import.request' && event.resourceId === updated.id)?.details?.after)
            .toMatchObject({ items: expect.arrayContaining([{ assetId: 'tool-a', name: 'tool-b', kind: 'plugin', version: '2.0.0' }, { assetId: 'tool-b', name: 'tool-b', kind: 'plugin', version: '1.0.0' }]) });
        const versions = await f.jobs.versions(f.pin.repository);
        expect(versions).toHaveLength(3);
        const repeated = await importSource([renamed, tool('tool-b')], 'b'.repeat(40));
        expect(repeated.state, repeated.message).toBe('SUCCEEDED');
        expect(repeated.items.every(item => item.action === 'unchanged')).toBe(true);
        expect(await f.jobs.versions(f.pin.repository)).toEqual(versions);
        expect(await f.plugins.versions(a.id)).toHaveLength(2);
        expect(await f.plugins.versions(b.id)).toHaveLength(1);
    });

    it('same-job retry repairs a persisted legacy name-mismatch plan after the real SQL publication rolled back', async () => {
        const first = await importSource(tool('tool-a'), 'a'.repeat(40));
        expect(first.state, first.message).toBe('SUCCEEDED');
        const nativeId = first.items[0].native!.id;
        const head = (await f.plugins.get(nativeId))!;
        const oldHistory = await f.plugins.versions(nativeId);
        const oldVersions = await f.jobs.versions(f.pin.repository);
        const projectPin = await assignCurrent(nativeId);
        const preview = ToolAssetAdapter.prototype.preview;
        const legacyPlan = vi.spyOn(ToolAssetAdapter.prototype, 'preview').mockImplementation(async function (this: ToolAssetAdapter, ...args: Parameters<ToolAssetAdapter['preview']>) {
            const item = await preview.call(this, ...args);
            if (!item.publication || !item.native || item.resolved.asset.version !== '2.0.0') return item;
            const publication = { ...item.publication, name: item.resolved.asset.card.name };
            return { ...item, publication, native: this.pin(plannedToolCard(item.native.id, item.native.version, publication)) };
        });
        const next = renamedTool();
        let failed: Awaited<ReturnType<typeof importSource>>;
        try { failed = await importSource(next, 'b'.repeat(40)); } finally { legacyPlan.mockRestore(); }
        expect(failed.state, failed.message).toBe('NEEDS_INPUT');
        expect(failed.message).toContain('Native-публикация отличается от закреплённого плана');
        expect(await f.plugins.get(nativeId)).toEqual(head);
        expect(await f.plugins.versions(nativeId)).toEqual(oldHistory);
        expect(await f.jobs.versions(f.pin.repository)).toEqual(oldVersions);
        expect((await f.pool.query("SELECT * FROM project_assets WHERE project_id='rename-project'")).rows[0]).toEqual(projectPin);

        const retry = await f.jobs.retry(failed.id, actor);
        expect(retry.id).toBe(failed.id);
        const worker = f.worker();
        try { await worker.flush(); } finally { await worker.stop(); }
        const saved = await f.jobs.get(failed.id);
        expect(saved.state, saved.message).toBe('SUCCEEDED');
        expect(saved.request_key).toBe(failed.request_key);
        expect((await f.plugins.get(nativeId))).toMatchObject({ id: nativeId, name: head.name, version: 2, files: (next.asset as ToolAsset).card.files });
        expect(await f.plugins.versions(nativeId)).toHaveLength(2);
        expect(await f.jobs.versions(f.pin.repository)).toHaveLength(2);
        expect((await f.pool.query("SELECT * FROM project_assets WHERE project_id='rename-project'")).rows[0]).toEqual(projectPin);
    });
});
