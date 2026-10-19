import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const [runtimeArgument, output] = process.argv.slice(2);
if (!runtimeArgument) throw new Error('Укажите распакованный native RAG runtime.');
const runtime = path.resolve(runtimeArgument);
const load = name => import(pathToFileURL(path.join(runtime, name)).href);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-native-profile-'));
const storePath = path.join(root, '.opencode', 'rag-store');
let partial = false;let calls = 0;let storedInputs = 0;let store;
const evidence = { status: 'failed', platform: process.platform, architecture: process.arch, checks: [] };
const provider = http.createServer(async (request, response) => {
    const data = [];for await (const chunk of request) data.push(chunk);
    const body = JSON.parse(Buffer.concat(data));calls++;
    const texts = Array.isArray(body.input) ? body.input : [body.input];
    if (!texts.includes('dimension-probe')) storedInputs += texts.length;
    if (partial && texts.some(text => text.includes('secondInvoice'))) {
        response.writeHead(401, { 'content-type': 'application/json' });response.end('{"error":"fixture denied"}');return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ embeddings: texts.map(() => body.model === 'fixture-a' ? [1, 0, 0, 0] : [0, 1, 0, 0]) }));
});
try {
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    await fs.mkdir(storePath, { recursive: true });
    await fs.writeFile(path.join(root, 'first.ts'), 'export function firstInvoice(amount: number): number { return amount * 2; }\n');
    await fs.writeFile(path.join(root, 'second.ts'), 'export function secondInvoice(amount: number): number { return amount * 3; }\n');
    const { DEFAULT_CONFIG } = await load('upstream/dist/core/config.js');
    const { createVectorStore } = await load('upstream/dist/vectorstore/factory.js');
    const { createEmbedder } = await load('upstream/dist/embedder/factory.js');
    const { runIndexPass } = await load('upstream/dist/indexer/pipeline.js');
    const { protectedNativeStore } = await load('rag-plugin-errors.mjs');
    const config = structuredClone(DEFAULT_CONFIG);
    config.embedding = { provider: 'ollama', model: 'fixture-a', baseUrl: `http://127.0.0.1:${provider.address().port}/api`, vectorDimension: 4 };
    config.indexing = { ...config.indexing, includeExtensions: ['.ts'], minFileSizeBytes: 0, embedBatchSize: 1, embedConcurrency: 1 };
    for (const name of ['description', 'imageDescription', 'reranking', 'decision']) config[name] = { ...config[name], enabled: false };
    config.logging = { ...config.logging, level: 'none' };
    store = createVectorStore(config, storePath, 4);
    let embedder = createEmbedder(config);
    const run = () => runIndexPass({ cwd: root, storePath, config, store, embedder, dimension: 4 });
    const readProfile = () => fs.readFile(path.join(storePath, 'neurocenter-index-profile.json'), 'utf8').then(JSON.parse);
    const rows = async () => (await (await store.getTable()).query().toArray()).map(row => ({ ...row, embedding: Array.from(row.embedding) })).sort((a, b) => a.id.localeCompare(b.id));
    const initial = await run();assert.ok(initial.finalCount >= 2);assert.equal((await readProfile()).state, 'ready');
    const original = await rows();
    const before = storedInputs;
    config.embedding.model = 'fixture-b';embedder = createEmbedder(config);
    const guarded = protectedNativeStore(store, { storePath, config, dimension: 4, embedder });
    await assert.rejects(guarded.searchWithFilter([0, 1, 0, 0], 3), /модель|Модель/);
    const switched = await run();assert.equal(switched.rebuildPerformed, true);assert.ok(storedInputs - before >= 2);
    assert.equal(switched.unchangedFiles, 0);assert.equal((await readProfile()).profile.model, 'fixture-b');
    assert.notDeepEqual((await rows()).map(row => row.embedding), original.map(row => row.embedding));
    assert.ok((await guarded.searchWithFilter([0, 1, 0, 0], 3)).length > 0);
    evidence.checks.push('Модель той же размерности перестраивает неизменённые файлы и только затем разрешает поиск');
    const preserved = await rows();const manifest = await fs.readFile(path.join(storePath, 'manifest.json'), 'utf8');
    config.embedding.model = 'fixture-c';embedder = createEmbedder(config);partial = true;
    await assert.rejects(run(), /Ошибка локального индекса/);
    assert.deepEqual(await rows(), preserved);assert.equal(await fs.readFile(path.join(storePath, 'manifest.json'), 'utf8'), manifest);
    assert.equal((await readProfile()).state, 'failed');
    evidence.checks.push('Частичный embedding failure после записи здоровых temp-строк сохраняет старые LanceDB и manifest побайтно');
    partial = false;await run();assert.equal((await readProfile()).state, 'ready');
    evidence.checks.push('Повтор после отказа выполняет полный rebuild и подтверждает новый профиль');
    await fs.writeFile(path.join(storePath, 'runtime-overrides.json'), JSON.stringify({ embedding: { model: 'fixture-d' } }));
    const beforeMismatch = calls;await assert.rejects(run(), /перезапустите/);assert.equal(calls, beforeMismatch);
    evidence.checks.push('Runtime model override со старым embedder требует перезапуск без запросов к модели');
    await fs.rm(path.join(storePath, 'runtime-overrides.json'));
    await store.close();store = undefined;
    await fs.writeFile(path.join(root, 'opencode-rag.json'), JSON.stringify({ embedding: config.embedding, vectorStore: { path: '.opencode/rag-store' },
        openCode: { autoIndex: { enabled: false } } }));
    const { default: plugin } = await load('rag-plugin.mjs');
    await plugin({ directory: root });
    const presence = path.join(storePath, 'neurocenter-session.lock');
    const owner = JSON.parse(await fs.readFile(presence)).owner;
    await assert.rejects(fs.stat(path.join(storePath, 'watcher.lock')), { code: 'ENOENT' });
    await plugin({ directory: root });assert.equal(JSON.parse(await fs.readFile(presence)).owner, owner);
    process.emit('beforeExit', 0);
    const until = Date.now() + 5000;
    while (await fs.stat(presence).then(() => true, () => false)) {
        assert.ok(Date.now() < until, 'Native session presence не освобождён после shutdown');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    evidence.checks.push('Настоящая native factory при autoIndex=false удерживает presence, сохраняет token при reload и освобождает после закрытия stores');
    evidence.status = 'passed';
} catch (error) { evidence.error = error.stack;process.exitCode = 1; }
finally {
    await store?.close();
    const { destroyAllPooledConnections } = await load('upstream/dist/embedder/http.js');destroyAllPooledConnections();
    await new Promise(resolve => provider.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
    evidence.providerCalls = calls;evidence.realProfileChanged = false;
    if (output) await fs.writeFile(path.resolve(output), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
}
