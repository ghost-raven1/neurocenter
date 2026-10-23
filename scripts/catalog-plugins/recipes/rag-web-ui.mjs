import fs from 'node:fs/promises';
import path from 'node:path';

export const RAG_LOCAL_UI = Object.freeze({ schemaVersion: 1, application: 'opencode-rag', entrypoint: 'opencode-rag.mjs', args: ['ui', '--port', '0', '--no-open'] });
const bootstrap = '<script>const m=location.hash.match(/^#neurocenter-token=([a-f0-9]{48})$/);if(m){sessionStorage.setItem("opencode-rag-token",m[1]);history.replaceState(null,"",location.pathname);}</script>';
const serverChanges = [
    ['const store = new LanceDbStore(storePath, vectorDimension);', 'const store = protectedNativeStore(new LanceDbStore(storePath, vectorDimension), { storePath, config: cfg, get dimension() { return cfg.embedding.vectorDimension ?? vectorDimension; } });'],
    ['embedderPromise = Promise.resolve(createEmbedder(cfg));', 'embedderPromise = managedUiEmbedder(cfg, store).catch(error => { embedderPromise = null; throw error; });'],
    ['const apiHandler = createApiHandler(store, keywordIndex, storePath, cwd, cfg, getEmbedder, token, configPath);', 'const apiHandler = managedUiRequests(createApiHandler(store, keywordIndex, storePath, cwd, cfg, getEmbedder, token, configPath), { root: cwd, storePath, configPath });'],
    ['                port,', '                port: server.address().port,'],
    ['server.close(() => {\n                        store.close().catch(() => { });\n                        keywordIndex.close();\n                        resolveClose();\n                    });', 'server.close(async () => {\n                        try { await store.close(); } catch { } finally { keywordIndex.close(); resolveClose(); }\n                    });'],
];
const apiChanges = [
    ['import { retrieve } from "../retriever/retriever.js";', 'import { retrieve as upstreamRetrieve } from "../retriever/retriever.js";\nconst retrieve = strictRetriever(upstreamRetrieve);'],
    ['response = handleConfigUpdate(configPath, configRef, body);', 'await checkedUiConfigPatch(cwd, configPath, body);\n                response = handleConfigUpdate(configPath, configRef, body);'],
    ['response = await handleIndexingStatus(storePath, cwd);', 'statusCache = null;\n            response = managedUiIndexingStatus(await handleIndexingStatus(storePath, cwd), storePath);'],
    ['for (const [key, value] of Object.entries(indexingPatch)) {\n            const ok = updateConfigValue(configPath, ["indexing", key], value);\n            if (!ok) {\n                return { status: 500, body: { error: `Failed to write \'indexing.${key}\' to ${configPath}` } };\n            }\n        }', 'const failure = persistUiConfigPatch(configPath, indexingPatch);\n        if (failure) return failure;'],
];

/** Uses the pinned Preact bundle aliases; only its Index Status component is replaced. */
function managedDashboardStatus() {
    const [status, setStatus] = s(null), [error, setError] = s(null), [notice, setNotice] = s(null), [posting, setPosting] = s(false), [loading, setLoading] = s(true), [unconfirmed, setUnconfirmed] = s(false);
    const alive = i(true), busy = i(false), expected = i(null), generation = i(0);
    const refresh = async () => {
        if (busy.current) return;
        busy.current = true;
        const requestedGeneration = generation.current;
        try {
            const response = await W.indexStatus(), value = response.body ?? response;
            if (!alive.current || requestedGeneration !== generation.current) return;
            setStatus(value); setError(null); setUnconfirmed(false);
            const run = value.reindex;
            if (expected.current && run?.id !== expected.current) {
                expected.current = null;
                setNotice('The result of this request is unavailable. The current index status is shown below; refresh before starting again.');
            } else if (expected.current === run?.id && ['complete', 'failed', 'cancelled'].includes(run.state)) {
                expected.current = null;
                V(run.state === 'complete' ? 'success' : 'error', run.state === 'complete' ? 'Reindex complete' : run.error);
            }
        } catch (failure) { if (alive.current && requestedGeneration === generation.current) setError(failure.message || 'Index status is unavailable. Retry to check the actual result.'); }
        finally { busy.current = false; if (alive.current && requestedGeneration === generation.current) setLoading(false); }
    };
    const active = ['starting', 'running'].includes(status?.reindex?.state);
    const waitingForOwnRun = Boolean(expected.current);
    u(() => { alive.current = true; refresh(); return () => { alive.current = false; }; }, []);
    u(() => { if (!active && !posting && !waitingForOwnRun && !unconfirmed) return; const timer = setInterval(refresh, 2000); return () => clearInterval(timer); }, [active, posting, waitingForOwnRun, unconfirmed]);
    const start = async () => {
        generation.current++; setPosting(true); setError(null); setNotice(null); setUnconfirmed(false);
        try { const response = await W.triggerReindex(); generation.current++; expected.current = (response.body ?? response).runId; await refresh(); }
        catch (failure) {
            generation.current++;
            if (alive.current) { setUnconfirmed(true); setError(failure.message || 'Request confirmation is unavailable.'); setNotice('The reindex request was not confirmed. Refresh status to check its actual result before starting again.'); }
            await refresh();
        }
        finally { if (alive.current) setPosting(false); }
    };
    const field = (label, value) => l('div', { children: [l('span', { className: 'text-xs text-slate-500 block', children: label }), l('span', { className: 'text-sm font-mono', children: value })] });
    const run = status?.reindex, progress = run?.progress, manifest = status?.manifest;
    const freshness = status?.freshness === 'never' ? 'Not indexed yet' : status?.freshness === 'changed'
        ? `${status.staleFileCount} indexed file(s) changed` : 'Indexed files unchanged; reindex to include new files';
    return l('section', { className: 'kpi-card p-4 mb-6', children: [
        l('h2', { className: 'text-lg font-semibold mb-3', children: 'Index Status' }),
        loading ? l('p', { role: 'status', children: 'Loading index status...' }) : manifest ? l('div', { className: 'grid grid-cols-2 lg:grid-cols-4 gap-4', children: [
            field('Last Indexed', manifest.lastIndexedAt ? ft(manifest.lastIndexedAt) : 'Never'), field('Total Chunks', $(manifest.totalChunks)),
            field('Total Files', $(manifest.totalFiles)), field('Index Freshness', freshness),
        ] }) : null,
        error ? l('p', { role: 'alert', className: 'text-red-400 mt-3', children: error }) : null,
        notice ? l('p', { role: 'status', className: 'text-amber-400 mt-3', children: notice }) : null,
        run ? l('div', { role: ['failed', 'cancelled'].includes(run.state) ? 'alert' : 'status', className: 'mt-3 text-sm', children: [
            l('p', { children: run.state === 'starting' ? 'Checking embedding model...' : run.state === 'running' ? 'Reindexing...' : run.state === 'complete' ? 'Reindex complete' : run.error }),
            progress ? l('p', { children: `Files completed: ${progress.completedFiles}${progress.totalFiles == null ? '' : ` / ${progress.totalFiles}`}; failed: ${progress.failedFiles}` }) : null,
            progress?.currentFile ? l('p', { className: 'font-mono break-all', children: progress.currentFile }) : null,
        ] }) : null,
        l('div', { className: 'flex gap-3 mt-3', children: [
            l('button', { className: 'bg-brand-600 hover:bg-brand-500 text-white px-4 py-1.5 rounded text-sm', disabled: posting || active || unconfirmed || waitingForOwnRun, onClick: start, children: unconfirmed || waitingForOwnRun && !active ? 'Checking request...' : posting || active ? 'Reindexing...' : 'Reindex Now' }),
            l('button', { className: 'text-brand-400 text-sm', onClick: refresh, children: 'Refresh status' }),
        ] }),
    ] });
}

function patchDashboard(source) {
    const start = source.indexOf('function pt(){'), end = source.indexOf('function mt(){', start);
    const previous = source.slice(start, end);
    if (start < 0 || end < 0 || source.split('function pt(){').length !== 2
        || !previous.includes('Reindex is still running') || !previous.includes('✓ Up to date') || !previous.includes('manifest?.lastIndexedAt!==n')) {
        throw new Error('Изменился компонент статуса Web UI OpenCodeRAG; требуется новая ревизия адаптера.');
    }
    const config = 'l(`div`,{className:`mt-6`,children:l(`h2`,{className:`text-lg font-semibold mb-3`,children:l(`a`,{href:`#config`,className:`hover:text-brand-400 transition-colors`,children:`Configuration`})})})';
    const changed = source.slice(0, start) + managedDashboardStatus.toString().replace('managedDashboardStatus', 'pt') + source.slice(end);
    return replaceKnown(changed, [[config, 'l(`div`,{className:`kpi-card p-4 mt-6`,children:[l(`a`,{href:`#config`,className:`text-brand-400 font-semibold`,children:`View configuration →`}),l(`p`,{className:`text-sm text-slate-400 mt-2`,children:`View the effective embedding model, vector dimensions and indexing folders. API keys stay hidden.`})]})']]);
}

function replaceKnown(source, replacements) {
    if (replacements.some(([before]) => source.split(before).length !== 2)) { throw new Error('Изменился upstream Web UI OpenCodeRAG; требуется новая ревизия адаптера.'); }
    return replacements.reduce((text, [before, after]) => text.replace(before, after), source);
}

/** Патчится реальный upstream UI: loopback, token, assets и маршруты остаются его реализацией. */
export async function applyManagedWebUiCompatibility(directory) {
    const serverFile = path.join(directory, 'upstream/dist/web/server.js'), apiFile = path.join(directory, 'upstream/dist/web/api.js');
    const htmlFile = path.join(directory, 'upstream/dist/web/ui/index.html');
    const [source, api, html] = await Promise.all([fs.readFile(serverFile, 'utf8'), fs.readFile(apiFile, 'utf8'), fs.readFile(htmlFile, 'utf8')]);
    if (source.includes('managedUiRequests') || api.includes('managedUiReindex') || html.includes('neurocenter-token')) { throw new Error('Web UI OpenCodeRAG уже адаптирован.'); }
    const imports = 'import { protectedNativeStore } from "../../../rag-plugin-errors.mjs";\n'
        + 'import { managedUiEmbedder } from "../../../rag-ui.mjs";\nimport { managedUiRequests } from "../../../rag-ui-guards.mjs";\n';
    const changedServer = imports + replaceKnown(source, serverChanges);
    let changedApi = 'import { strictRetriever } from "../../../rag-errors.mjs";\n'
        + 'import { persistUiConfigPatch } from "../../../rag-ui-config.mjs";\n'
        + 'import { managedUiReindex, managedUiIndexingStatus, checkedUiConfigPatch } from "../../../rag-ui-guards.mjs";\n' + replaceKnown(api, apiChanges);
    const start = changedApi.indexOf('async function handleReindex(cwd, cfg, storePath, store, getEmbedder) {');
    const end = changedApi.indexOf('\n/**\n * Return the effective configuration', start);
    if (start < 0 || end < 0 || !changedApi.slice(start, end).includes('runIndexPass({ cwd, storePath, config: cfg, store, embedder })')) {
        throw new Error('Изменилась индексация upstream Web UI OpenCodeRAG.');
    }
    changedApi = changedApi.slice(0, start) + `async function handleReindex(cwd, cfg, storePath, store, getEmbedder) {
    const { runIndexPass } = await import("../indexer.js");
    return managedUiReindex({ cwd, cfg, storePath, store, getEmbedder, runIndexPass,
        onFinished() { statusCache = null; projectionCache = null; } });
}
` + changedApi.slice(end);
    if (html.split('<head>').length !== 2 || !html.includes('/ui/assets/')) { throw new Error('Web UI отсутствует в закреплённой поставке OpenCodeRAG.'); }
    for (const asset of [...html.matchAll(/(?:src|href)="(\/ui\/assets\/[^"?#]+)"/g)].map(match => match[1])) {
        const correct = path.join(directory, 'upstream/dist/web/ui', asset.slice('/ui/'.length));
        if (!(await fs.stat(correct)).isFile()) { throw new Error('В поставке отсутствует ресурс Web UI.'); }
    }
    const script = html.match(/<script type="module" crossorigin src="(\/ui\/assets\/[^"?#]+\.js)"/);
    if (!script) throw new Error('Отсутствует закреплённый Dashboard OpenCodeRAG.');
    const scriptFile = path.join(directory, 'upstream/dist/web/ui', script[1].slice('/ui/'.length));
    const dashboard = patchDashboard(await fs.readFile(scriptFile, 'utf8'));
    await Promise.all([fs.writeFile(serverFile, changedServer), fs.writeFile(apiFile, changedApi), fs.writeFile(scriptFile, dashboard), fs.writeFile(htmlFile, html.replace('<head>', '<head>' + bootstrap))]);
    return { id: 'neurocenter-rag-web-ui', version: 2, files: ['upstream/dist/web/server.js', 'upstream/dist/web/api.js', 'upstream/dist/web/ui/index.html', 'upstream/dist/web/ui/' + script[1].slice('/ui/'.length)] };
}
