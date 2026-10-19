import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { workspaceFixture } from './bridge-fixture.js';
import { bindProject } from '../src/bridge/workspace.js';
import { syncRagDb } from '../src/tools/sync-rag-db.js';
import { restoreRagDb } from '../src/tools/restore-rag-db.js';
import { indexSnapshotHash, rowFingerprint } from '../src/features/rag-index/contract.js';
import { contentHash } from '../src/lib/lancedb.js';
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/bridge/state.js', async original => ({ ...await original<typeof import('../src/bridge/state.js')>(), authorizedFetch: transport.fetch }));
const runtime = process.env.NEUROCENTER_RAG_PLUGIN_TEST_RUNTIME;
// Выполняется явно с распакованным проверенным native-пакетом; CI без автономных артефактов не подменяет его моками.
const nativeTest = runtime ? it : it.skip;
afterEach(() => { vi.unstubAllEnvs(); });

nativeTest('Настоящий native autoindex → bridge seal → другая папка → native semantic search', async () => {
    const fixture = await workspaceFixture();
    // Native-модули выполняются исходным Node loader, без переписывания WASM/Arrow через Vite.
    const nativeRequire = createRequire(import.meta.url);
    const load = async (name: string) => nativeRequire(path.join(runtime!, 'upstream/dist', name));
    let indexer: any; let sourceStore: any; let restoredStore: any;
    let calls = 0;
    const provider = http.createServer(async (request, response) => {
        const data: Buffer[] = []; for await (const part of request) { data.push(part); }
        const body = JSON.parse(Buffer.concat(data).toString()); calls++;
        const texts = Array.isArray(body.input) ? body.input : [body.input];
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ embeddings: texts.map(() => [1, 0.1, 0.2]) }));
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    try {
        const port = (provider.address() as { port: number }).port;
        const configuration = { embedding: { provider: 'ollama', model: 'native-roundtrip', baseUrl: `http://127.0.0.1:${port}/api`, vectorDimension: 3 },
            vectorStore: { path: './knowledge-index' }, indexing: { includeExtensions: ['.ts'], embedBatchSize: 1 },
            description: { enabled: false }, imageDescription: { enabled: false }, memory: { enabled: false }, reranking: { enabled: false },
            logging: { level: 'none' }, openCode: { autoIndex: { enabled: true, debounceMs: 10, intervalMs: 300_000 } } };
        await fs.writeFile(path.join(fixture.root, '.opencode/rag.json'), JSON.stringify(configuration));
        await fs.writeFile(path.join(fixture.root, 'sample.ts'), 'export function calculateNativeInvoice(amount: number): number { return amount * 2; }\n');
        const { loadConfig } = await load('core/config.js'); const cfg = loadConfig(path.join(fixture.root, '.opencode/rag.json'));
        const { createEmbedder } = await load('embedder/factory.js'); const embedder = createEmbedder(cfg);
        const { createVectorStore } = await load('vectorstore/factory.js');
        const { KeywordIndex } = await load('retriever/keyword-index.js');
        const { createBackgroundIndexer } = await load('watcher.js');
        const storePath = path.join(fixture.root, 'knowledge-index'); await fs.mkdir(storePath); sourceStore = createVectorStore(cfg, storePath, 3);
        indexer = createBackgroundIndexer({ cwd: fixture.root, storePath, config: cfg, store: sourceStore, embedder,
            keywordIndex: new KeywordIndex(storePath), dimension: 3, logFilePath: path.join(storePath, 'fixture.log'), logLevel: 'none' });
        const deadline = Date.now() + 30_000;
        for (;;) {
            const status = JSON.parse(await fs.readFile(path.join(storePath, 'watcher-status.json'), 'utf8').catch(() => '{}'));
            if (status.lastSuccessAt && !status.running) { break; }
            if (Date.now() >= deadline) { throw new Error('Native autoindex не завершился: ' + JSON.stringify(status)); }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        expect(await sourceStore.count()).toBeGreaterThan(0);
        const profile = { provider: 'ollama', model: 'native-roundtrip', dimension: 3 };
        const rows: Record<string, any> = Object.create(null); let complete = false; let hash: string | null = null;
        const metadata = () => ({ projectKey: 'test-project', fingerprintVersion: 1, indexProfile: Object.keys(rows).length ? profile : null,
            fingerprints: Object.fromEntries(Object.values(rows).map(row => [row.id, rowFingerprint(row)])),
            ids: Object.fromEntries(Object.values(rows).map(row => [row.id, contentHash(row.content)])), rowCount: Object.keys(rows).length,
            incompleteRows: 0, complete, indexState: complete ? 'ready' : 'syncing', snapshotHash: hash });
        transport.fetch.mockReset().mockImplementation(async (route: string, options?: RequestInit) => {
            if (options) {
                const body = JSON.parse(String(options.body));
                for (const row of body.chunks) { expect(path.isAbsolute(row.filePath)).toBe(false); rows[row.id] = row; }
                for (const id of body.deletes) { delete rows[id]; }
                complete = body.snapshot.complete;
                if (complete) { hash = indexSnapshotHash(profile, metadata().fingerprints); expect(hash).toBe(body.snapshot.hash); }
                return Response.json({ upserted: body.chunks.length, deleted: body.deletes.length, complete, snapshotHash: hash });
            }
            return Response.json(route.includes('/chunks') ? { ...metadata(), chunks: Object.values(rows), hasMore: false } : metadata());
        });
        const pushed = JSON.parse(await syncRagDb({ project: fixture.root }, fixture.root));
        expect(pushed).toMatchObject({ complete: true, remaining: 0, indexProfile: profile });
        await indexer.close(); indexer = undefined; await sourceStore.close(); sourceStore = undefined;
        const target = path.join(path.dirname(fixture.root), 'restored-native'); await fs.mkdir(path.join(target, '.opencode'), { recursive: true });
        await fs.writeFile(path.join(target, '.opencode/rag.json'), JSON.stringify(configuration));
        await fs.copyFile(path.join(fixture.root, 'sample.ts'), path.join(target, 'sample.ts'));
        await bindProject('test-project', path.basename(target));
        expect(JSON.parse(await restoreRagDb({ projectKey: 'test-project', project: target }, target))).toMatchObject({ complete: true, snapshotHash: pushed.snapshotHash });
        restoredStore = createVectorStore(cfg, path.join(target, 'knowledge-index'), 3);
        const { retrieve } = await load('retriever/retriever.js');
        const before = calls; const result = await retrieve('calculateNativeInvoice', embedder, restoredStore, { topK: 5, minScore: 0, hybridEnabled: false });
        expect(calls - before).toBe(1); expect(result.length).toBeGreaterThan(0);
        expect(result[0].chunk.content).toContain('calculateNativeInvoice');
        expect(result[0].chunk.metadata.filePath).toBe(path.join(target, 'sample.ts'));
    } finally {
        await indexer?.close(); await sourceStore?.close(); await restoredStore?.close();
        const { destroyAllPooledConnections } = await load('embedder/http.js'); destroyAllPooledConnections();
        await new Promise<void>(resolve => provider.close(() => resolve())); await fs.rm(fixture.temporary, { recursive: true, force: true });
    }
}, 45_000);
