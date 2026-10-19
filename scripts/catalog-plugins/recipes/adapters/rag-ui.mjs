import fs from 'node:fs/promises';
import path from 'node:path';
import { readRagConfiguration, checkedWorkspacePath } from './rag-context.mjs';
import { readStoreDimension } from './upstream/dist/vectorstore/lancedb.js';
import { createEmbedder, probeEmbeddingDimension } from './upstream/dist/embedder/factory.js';
import { startWebUi } from './upstream/dist/web/server.js';
import { findConfigFile } from './upstream/dist/core/config.js';
import { destroyAllPooledConnections } from './upstream/dist/embedder/http.js';
import { protectedEmbedder } from './rag-errors.mjs';
import { acquireManagedIndexLock, releaseManagedIndexLock, assertNoIndexWriter } from './rag-index-lock.mjs';
import { closeManagedUiMutations } from './rag-ui-guards.mjs';
import { rememberUiConfig } from './rag-ui-config.mjs';

/** Провайдер вызывается только по явному поиску или перестроению, а не при открытии dashboard. */
export async function managedUiEmbedder(config, store) {
    const embedder = protectedEmbedder(createEmbedder({ ...config, logging: { ...config.logging, level: 'none' } }));
    const probe = await probeEmbeddingDimension(embedder);
    if (!probe.dimension) { throw new Error('Модель эмбеддингов недоступна. Проверьте локальное подключение.'); }
    config.embedding.vectorDimension = probe.dimension;
    store.vectorDimension = probe.dimension;
    return embedder;
}

/** Настоящий upstream Web UI; приватный URL передаётся только локальному владельцу по IPC. */
export async function runManagedRagUi({ port = 3210 } = {}) {
    const root = await fs.realpath(process.cwd());
    const config = await readRagConfiguration(root, process.env, { ui: true });
    const storePath = await checkedWorkspacePath(root, config.vectorStore.path);
    await fs.mkdir(storePath, { recursive: true });
    await assertNoIndexWriter(storePath);
    const presence = path.join(storePath, 'neurocenter-ui-session.lock');
    if (!await acquireManagedIndexLock(presence)) { throw new Error('OpenCodeRAG UI уже открыт для этой папки проекта.'); }
    let server, closing;
    const close = () => closing ||= (async () => {
        try { await closeManagedUiMutations({ shutdown: true }); await server?.close(); }
        finally { destroyAllPooledConnections(); await releaseManagedIndexLock(presence); }
    })();
    try {
        await assertNoIndexWriter(storePath);
        const dimension = await readStoreDimension(storePath) || config.embedding.vectorDimension || 384;
        config.embedding.vectorDimension ??= dimension;
        const configPath = findConfigFile(root) || path.join(root, 'opencode-rag.json');
        rememberUiConfig(root, configPath);
        server = await startWebUi(storePath, port, root, dimension, config, configPath);
        // Upstream оставляет ref-таймеры после индекса: выходим только после полного безопасного cleanup.
        const shutdown = () => { void close().then(() => process.exit(process.exitCode || 0), () => process.exit(1)); };
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);
        process.once('disconnect', shutdown);
        if (process.send) {
            if (!process.connected) { await close(); process.exit(0); }
            const url = `http://127.0.0.1:${server.port}/#neurocenter-token=${server.token}`;
            process.send({ type: 'neurocenter-rag-ui-ready', url, port: server.port }, error => { if (error) { shutdown(); } });
        } else { console.error('OpenCodeRAG UI готов. Запустите его через мост, чтобы открыть защищённое окно.'); }
        return { close, port: server.port };
    } catch (error) { await close(); throw error; }
}
