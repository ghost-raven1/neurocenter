import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, findConfigFile, loadConfig, resolveLogConfig } from './upstream/dist/core/config.js';
import { createEmbedder, probeEmbeddingDimension } from './upstream/dist/embedder/factory.js';
import { createVectorStore } from './upstream/dist/vectorstore/factory.js';
import { readStoreDimension } from './upstream/dist/vectorstore/lancedb.js';
import { KeywordIndex } from './upstream/dist/retriever/keyword-index.js';
import { applyLocalRuntimeProfile } from './rag-local-runtime.mjs';
import { managedRagConfiguration, readProjectRagConfiguration } from './rag-plugin-config.mjs';

export function workspacePath(root, requested) {
    const resolved = path.resolve(root, requested);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Путь выходит за пределы проекта.');
    return resolved;
}

/** Запрещает переход через ссылки перед чтением или созданием проектных данных. */
export async function checkedWorkspacePath(root, requested) {
    const resolved = workspacePath(root, requested);
    const relative = path.relative(root, resolved);
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Ссылки в путях данных RAG не поддерживаются.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return resolved;
}

/** Секрет остаётся в памяти launcher; конфиг проекта и upstream setup не изменяются. */
export async function readRagConfiguration(root, env = process.env, { ui = false } = {}) {
    const source = findConfigFile(root);
    if (source) await checkedWorkspacePath(root, source);
    const cfg = managedRagConfiguration(source ? loadConfig(source) : structuredClone(DEFAULT_CONFIG), readProjectRagConfiguration(source), root);
    const provider = env.NEUROCENTER_RAG_EMBEDDING_PROVIDER || cfg.embedding.provider || 'ollama';
    if (!['ollama', 'openai'].includes(provider)) throw new Error('Выберите протокол эмбеддингов ollama или openai.');
    const baseUrl = env.NEUROCENTER_RAG_EMBEDDING_URL || cfg.embedding.baseUrl;
    const model = env.NEUROCENTER_RAG_EMBEDDING_MODEL || cfg.embedding.model;
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !model?.trim()) throw new Error('Требуются URL и модель эмбеддингов.');
    cfg.embedding = { ...cfg.embedding, provider, baseUrl, model,
        apiKey: env.NEUROCENTER_RAG_EMBEDDING_KEY || cfg.embedding.apiKey, timeoutMs: 30_000 };
    cfg.autoUpdate = { ...cfg.autoUpdate, enabled: false, autoInstall: false };
    if (!ui) cfg.openCode = { ...cfg.openCode, autoIndex: { ...cfg.openCode.autoIndex, enabled: false } };
    // Дополнительные модели не вызываются неявно: wizard настраивает только эмбеддинги.
    if (!ui) for (const name of ['description', 'imageDescription', 'decision', 'reranking']) cfg[name] = { ...cfg[name], enabled: false };
    await checkedWorkspacePath(root, cfg.vectorStore.path);
    return managedRagConfiguration(applyLocalRuntimeProfile(cfg), cfg, root);
}

/** Провайдер вызывается только при явном запросе поиска или индексирования. */
export async function createRagContext(root, cfg) {
    // Ollama пишет исходный ответ в свой журнал до внешнего перехвата ошибок.
    const embedder = createEmbedder({ ...cfg, logging: { ...cfg.logging, level: 'none' } });
    const storePath = await checkedWorkspacePath(root, cfg.vectorStore.path);
    const existingDimension = await readStoreDimension(storePath);
    const probe = await probeEmbeddingDimension(embedder);
    if (!probe.dimension) throw new Error('Модель эмбеддингов недоступна: проверьте локальную настройку.');
    if (existingDimension && existingDimension !== probe.dimension) throw new Error('Размерность модели отличается от существующего индекса. Выберите исходную модель или создайте отдельную копию проекта.');
    const dimension = probe.dimension;
    cfg.embedding.vectorDimension = dimension;
    await fs.mkdir(storePath, { recursive: true });
    const store = createVectorStore(cfg, storePath, dimension);
    let keywordIndex;
    try { keywordIndex = await KeywordIndex.load(storePath); }
    catch (error) { if (error.code !== 'ENOENT') { await store.close(); throw error; } keywordIndex = new KeywordIndex(storePath); }
    return { config: cfg, embedder, store, storePath, keywordIndex, dimension,
        logFilePath: path.resolve(root, resolveLogConfig(cfg).logFilePath) };
}
