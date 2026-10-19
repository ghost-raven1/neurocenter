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
    ['for (const [key, value] of Object.entries(indexingPatch)) {\n            const ok = updateConfigValue(configPath, ["indexing", key], value);\n            if (!ok) {\n                return { status: 500, body: { error: `Failed to write \'indexing.${key}\' to ${configPath}` } };\n            }\n        }', 'const failure = persistUiConfigPatch(configPath, indexingPatch);\n        if (failure) return failure;'],
];

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
        + 'import { managedUiReindex, checkedUiConfigPatch } from "../../../rag-ui-guards.mjs";\n' + replaceKnown(api, apiChanges);
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
    await Promise.all([fs.writeFile(serverFile, changedServer), fs.writeFile(apiFile, changedApi), fs.writeFile(htmlFile, html.replace('<head>', '<head>' + bootstrap))]);
    return { id: 'neurocenter-rag-web-ui', version: 1, files: ['upstream/dist/web/server.js', 'upstream/dist/web/api.js', 'upstream/dist/web/ui/index.html'] };
}
