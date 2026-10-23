/** Real prepared Web UI/API/pipeline with native LanceDB and an owned localhost embedding fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass isolated prepared native runtime');
const runtime = await fs.realpath(path.resolve(process.argv[2]));
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-rag-ui-native-')));
const load = name => import(pathToFileURL(path.join(runtime, name)).href);
let mode = 'held', calls = 0, release;
const held = new Promise(resolve => { release = resolve; });
const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw), texts = Array.isArray(body.input) ? body.input : [body.input]; calls++;
    if (texts.some(text => text.includes('Invoice'))) {
        if (mode === 'held') await held;
        if (mode === 'fail') { res.writeHead(503); res.end('{"error":"fixture-secret-should-stay-private"}'); return; }
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: body.model, data: texts.map((_, index) => ({ index, embedding: Array.from({ length: 2560 }, (_, i) => i + 1) })) }));
});
let ui;
try {
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const storePath = path.join(root, '.opencode', 'rag_db'), configPath = path.join(root, 'opencode-rag.json');
    await fs.mkdir(storePath, { recursive: true });
    await fs.writeFile(path.join(root, 'first.ts'), 'export function firstInvoice(amount:number){return amount*2;}\n');
    const { DEFAULT_CONFIG } = await load('upstream/dist/core/config.js');
    const cfg = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.embedding, { provider: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'fixture-embedding', apiKey: 'fixture-secret', vectorDimension: 2560, timeoutMs: 2000 });
    Object.assign(cfg.indexing, { includeExtensions: ['.ts'], minFileSizeBytes: 0, embedConcurrency: 1, embedBatchSize: 1 });
    cfg.description.enabled = false; cfg.imageDescription.enabled = false; cfg.logging.level = 'none';
    const original = JSON.stringify({ embedding: cfg.embedding, indexing: { includeExtensions: ['.ts'], minFileSizeBytes: 0 }, manual: 'preserved' });
    await fs.writeFile(configPath, original);
    const { rememberUiConfig } = await load('rag-ui-config.mjs'); rememberUiConfig(root, configPath);
    const { startWebUi } = await load('upstream/dist/web/server.js'); ui = await startWebUi(storePath, 0, root, 2560, cfg, configPath);
    const base = `http://127.0.0.1:${ui.port}`;
    const request = async (route, method = 'GET', body) => {
        const result = await fetch(base + route, { method, headers: { Authorization: 'Bearer ' + ui.token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const text = await result.text();
        assert.ok((result.headers.get('content-type') || '').includes('application/json'), `${route}: ${result.status} ${text}`);
        return { status: result.status, body: JSON.parse(text) };
    };
    const until = async predicate => {
        const deadline = Date.now() + 15000;
        do { const status = await request('/api/indexing/status'); if (predicate(status.body)) return status.body; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline);
        throw new Error('Owned UI status did not reach expected state');
    };
    const empty = await request('/api/indexing/status'); assert.equal(empty.body.freshness, 'never'); assert.equal(empty.body.manifest.lastIndexedAt, null); assert.equal(calls, 0);
    assert.equal((await fetch(base + '/api/indexing/status')).status, 401); assert.equal(calls, 0);
    const config = await request('/api/config'); assert.equal(config.body.config.embedding.model, 'fixture-embedding'); assert.equal(JSON.stringify(config).includes('fixture-secret'), false);
    const started = await request('/api/indexing/reindex', 'POST'); assert.equal(started.status, 200); assert.ok(started.body.runId);
    const running = await until(value => value.reindex?.state === 'running' && value.reindex.progress.currentFile);
    assert.equal(running.reindex.id, started.body.runId); assert.equal(running.freshness, 'never');
    const beforeConflict = calls; assert.equal((await request('/api/indexing/reindex', 'POST')).status, 409); assert.equal(calls, beforeConflict);
    mode = 'ok'; release();
    const complete = await until(value => value.reindex?.state === 'complete');
    assert.ok(complete.manifest.totalChunks > 0); assert.ok(complete.manifest.lastIndexedAt); assert.ok(complete.reindex.progress.completedFiles > 0);
    const beforeStatus = calls; await request('/api/indexing/status'); assert.equal(calls, beforeStatus);
    await fs.writeFile(path.join(root, 'first.ts'), 'export function changedInvoice(amount:number){return amount*3;}\n');
    assert.equal((await request('/api/indexing/status')).body.freshness, 'changed');
    mode = 'fail'; const failedStart = await request('/api/indexing/reindex', 'POST'); assert.equal(failedStart.status, 200);
    const failed = await until(value => value.reindex?.state === 'failed');
    assert.ok(failed.reindex.error); assert.ok(failed.reindex.finishedAt); assert.equal(JSON.stringify(failed).includes('fixture-secret'), false);
    assert.equal(await fs.readFile(configPath, 'utf8'), original);
    const html = await (await fetch(base)).text(), scriptPath = html.match(/src="(\/ui\/assets\/[^"?#]+\.js)"/)[1];
    const script = await (await fetch(base + scriptPath)).text();
    const component = script.slice(script.indexOf('function pt()'), script.indexOf('function mt(){', script.indexOf('function pt()')));
    const render = status => {
        const values = [status, null, null, false, false, false]; let cursor = 0;
        return vm.runInNewContext('(' + component + ')()', { s: () => [values[cursor++], () => {}], i: value => ({ current: value }), u() {}, l: (tag, props) => ({ tag, ...props }), $: String, ft: String });
    };
    assert.ok(JSON.stringify(render(empty.body)).includes('Not indexed yet'));
    assert.equal(JSON.stringify(render(empty.body)).includes('Up to date'), false);
    assert.ok(JSON.stringify(render(running)).includes('Reindexing...'));
    assert.ok(JSON.stringify(render(complete)).includes('Reindex complete'));
    assert.ok(JSON.stringify(render(failed)).includes(failed.reindex.error));
    const notices = [], expected = { current: started.body.runId }, refs = [{ current: true }, { current: false }, expected, { current: 0 }];
    let stateCursor = 0, refCursor = 0; const effects = [];
    vm.runInNewContext('(' + component + ')()', {
        s: () => { const index = stateCursor++; return [[complete, null, null, false, false, false][index], value => { if (index === 2) notices.push(value); }]; },
        i: () => refs[refCursor++], u: effect => effects.push(effect), l: (tag, props) => ({ tag, ...props }), $: String, ft: String,
        W: { indexStatus: async () => failed }, V: () => { throw new Error('Another run must not confirm this request'); },
    });
    const dispose = effects[0](); await new Promise(resolve => setImmediate(resolve)); dispose();
    assert.equal(expected.current, null); assert.ok(notices.some(value => value.includes('result of this request is unavailable')));
    // Accepted ACK + missed first read: the expected-ref transition must trigger effect cleanup even while active/posting stay false.
    const state = [null, null, null, false, false, false], sharedRefs = [{ current: true }, { current: false }, { current: started.body.runId }, { current: 0 }];
    let cleared = 0;
    const renderPending = () => {
        let stateIndex = 0, refIndex = 0; const captured = [];
        vm.runInNewContext('(' + component + ')()', {
            s: () => { const index = stateIndex++; return [state[index], value => { state[index] = value; }]; },
            i: () => sharedRefs[refIndex++], u: (effect, deps) => captured.push({ effect, deps }), l: (tag, props) => ({ tag, ...props }), $: String, ft: String,
            W: { indexStatus: async () => empty.body }, V: () => { throw new Error('Unknown outcome must not announce success'); },
            setInterval: () => 'owned-timer', clearInterval: timer => { assert.equal(timer, 'owned-timer'); cleared++; },
        });
        return captured;
    };
    const pendingEffects = renderPending(), stopPolling = pendingEffects[1].effect();
    assert.deepEqual(Array.from(pendingEffects[1].deps), [false, false, true, false]);
    const unmount = pendingEffects[0].effect(); await new Promise(resolve => setImmediate(resolve));
    const settledEffects = renderPending(); assert.deepEqual(Array.from(settledEffects[1].deps), [false, false, false, false]);
    stopPolling(); assert.equal(settledEffects[1].effect(), undefined); assert.equal(cleared, 1); unmount();
    const driver = api => {
        const values = [null, null, null, false, false, false], refs = [{ current: true }, { current: false }, { current: null }, { current: 0 }];
        const render = () => {
            let stateIndex = 0, refIndex = 0; const effects = [];
            const tree = vm.runInNewContext('(' + component + ')()', {
                s: () => { const index = stateIndex++; return [values[index], value => { values[index] = value; }]; },
                i: () => refs[refIndex++], u: (effect, deps) => effects.push({ effect, deps }), l: (tag, props) => ({ tag, ...props }), $: String, ft: String,
                W: api, V: () => { throw new Error('No completion may be invented'); }, setInterval: () => 'own', clearInterval() {},
            });
            const buttons = tree.children.at(-1).children;
            return { effects, start: buttons[0], refresh: buttons[1] };
        };
        return { values, refs, render };
    };
    let initialAck, reads = 0, posts = 0;
    const stale = driver({ indexStatus: async () => ++reads === 1 ? await new Promise(resolve => { initialAck = resolve; }) : running,
        triggerReindex: async () => { posts++; return started.body; } });
    const initial = stale.render(), closeInitial = initial.effects[0].effect();
    await initial.start.onClick(); assert.equal(stale.render().start.disabled, true); initialAck(empty.body); await new Promise(resolve => setImmediate(resolve));
    assert.equal(stale.refs[2].current, started.body.runId); assert.equal(stale.values[0], null); assert.equal(stale.values[2], null);
    assert.equal(stale.render().start.disabled, true);
    await stale.render().refresh.onClick(); assert.equal(stale.values[0].reindex.id, started.body.runId); assert.equal(posts, 1); closeInitial();
    let staleUnknownAck, unknownReads = 0;
    const staleUnknown = driver({ indexStatus: async () => ++unknownReads === 1 ? await new Promise(resolve => { staleUnknownAck = resolve; }) : running,
        triggerReindex: async () => { throw new Error('fixture lost ACK'); } });
    const staleUnknownInitial = staleUnknown.render(), closeUnknownInitial = staleUnknownInitial.effects[0].effect();
    await staleUnknownInitial.start.onClick(); staleUnknownAck(empty.body); await new Promise(resolve => setImmediate(resolve));
    assert.equal(staleUnknown.values[0], null); assert.equal(staleUnknown.values[5], true);
    await staleUnknown.render().refresh.onClick(); assert.equal(staleUnknown.values[0].reindex.state, 'running'); assert.equal(staleUnknown.values[5], false); closeUnknownInitial();
    let unavailable = false;
    const lost = driver({ indexStatus: async () => { if (unavailable) throw new Error('fixture status unavailable'); return running; },
        triggerReindex: async () => { posts++; throw new Error('fixture lost ACK'); } });
    await lost.render().start.onClick(); assert.equal(posts, 2); assert.equal(lost.values[0].reindex.state, 'running');
    assert.equal(lost.render().start.disabled, true); assert.ok(lost.values[2].includes('not confirmed'));
    unavailable = true; const unknown = driver({ indexStatus: async () => { if (unavailable) throw new Error('fixture status unavailable'); return empty.body; },
        triggerReindex: async () => { posts++; throw new Error('fixture lost ACK'); } });
    await unknown.render().start.onClick(); assert.equal(unknown.render().start.children, 'Checking request...'); assert.equal(unknown.render().start.disabled, true);
    unavailable = false; await unknown.render().refresh.onClick(); assert.equal(unknown.render().start.disabled, false); assert.equal(posts, 3);
    assert.ok(script.includes('View configuration →')); assert.equal(script.includes('Reindex is still running — check back later'), false);
    console.log(JSON.stringify({ status: 'passed', nativeDimension: 2560, calls, checks: ['never-is-not-up-to-date', 'status-read-no-inference', 'auth-still-required', 'effective-config-redacted', 'running-progress-and-conflict', 'native-complete-with-manifest', 'modified-file-refresh-not-stale-cache', 'partial-provider-failure-visible', 'manual-config-byte-preserved', 'actual-served-dashboard-render-and-config-action'] }));
} finally {
    release();
    const { closeManagedUiMutations } = await load('rag-ui-guards.mjs'); await closeManagedUiMutations();
    await ui?.close(); const { destroyAllPooledConnections } = await load('upstream/dist/embedder/http.js'); destroyAllPooledConnections();
    await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); });
    await fs.rm(root, { recursive: true, force: true });
}
