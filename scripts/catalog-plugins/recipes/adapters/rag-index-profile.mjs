import {hostedRagIdentity} from './rag-hosted.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { embeddingSignature, normalizeIndexProfile } from '../../../../services/shared/rag-index-contract.cjs';

const filename = 'neurocenter-index-profile.json';
const indexError = () => new Error('Ошибка локального индекса. Модель или подключение изменились: перезапустите OpenCode и выполните полное индексирование инструментом index_project или через интерфейс OpenCodeRAG.');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return 'null';
    throw error;
}));

/** Runtime-переключение подключения требует нового embedder, а не смены подписи старых векторов. */
async function identity(config, storePath, dimension, embedder) {
    const overrides = hostedRagIdentity(config) ? null : await readJson(path.join(storePath, 'runtime-overrides.json'));
    const embedding = { ...config.embedding };
    for (const key of ['provider', 'model', 'baseUrl']) {
        if (overrides?.embedding?.[key] !== undefined) embedding[key] = overrides.embedding[key];
    }
    const profile = normalizeIndexProfile({ provider: embedding.provider, model: embedding.model, dimension });
    const signature = embeddingSignature(profile, embedding.baseUrl);
    const original = { provider: config.embedding.provider, model: config.embedding.model, dimension };
    if (signature !== embeddingSignature(original, config.embedding.baseUrl)
        || (typeof embedder?.model === 'string' && embedder.model !== profile.model)) throw indexError();
    return { profile, embeddingSignature: signature };
}

async function writeState(storePath, record) {
    await fs.mkdir(storePath, { recursive: true });
    const temporary = path.join(storePath, `.${filename}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, ...record }) + '\n', { flag: 'wx' });
        await fs.rename(temporary, path.join(storePath, filename));
    } finally { await fs.rm(temporary, { force: true }); }
}

/** Выполняется под upstream index.lock; неизвестная модель перестраивается штатной атомарной заменой. */
export async function withManagedIndexProfile(options, run) {
    const startedAt = Date.now();
    let record;
    try {
        const dimension = options.dimension ?? options.config.embedding.vectorDimension ?? await options.store.getVectorDimension?.();
        record = await identity(options.config, options.storePath, dimension, options.embedder);
        const previous = await readJson(path.join(options.storePath, filename)).catch(() => null);
        const existingCount = await options.store.count();
        const verified = previous?.schemaVersion === 1 && previous.state === 'ready'
            && previous.embeddingSignature === record.embeddingSignature;
        await writeState(options.storePath, { ...record, state: 'indexing' });
        const stats = await run({ ...options, dimension, force: options.force || existingCount > 0 && !verified });
        const manifest = await readJson(path.join(options.storePath, 'manifest.json'));
        if (stats.skipped || options.abortSignal?.aborted || stats.embeddingUnavailable || stats.embeddingFailures > 0
            || stats.extractionFailures > 0 || stats.descriptionFailedFiles > 0
            || !Number.isFinite(manifest?.lastIndexedAt) || manifest.lastIndexedAt < startedAt) {
            throw indexError();
        }
        await writeState(options.storePath, { ...record, state: 'ready', indexedAt: manifest.lastIndexedAt });
        return stats;
    } catch (error) {
        if (record) await writeState(options.storePath, { ...record, state: 'failed' });
        throw error;
    }
}

/** Непроверенный непустой индекс нельзя запрашивать эмбеддером другой модели той же размерности. */
export async function requireManagedIndexProfile(store, storePath, config, dimension, embedder) {
    if (await store.count() === 0) return;
    const expected = await identity(config, storePath, dimension, embedder);
    const record = await readJson(path.join(storePath, filename)).catch(() => null);
    if (record?.schemaVersion !== 1 || record.state !== 'ready' || record.embeddingSignature !== expected.embeddingSignature
        || JSON.stringify(normalizeIndexProfile(record.profile)) !== JSON.stringify(expected.profile)) throw indexError();
    const manifest = await readJson(path.join(storePath, 'manifest.json')).catch(() => null);
    if (Number.isFinite(record.indexedAt) && record.indexedAt > 0 && record.indexedAt === manifest?.lastIndexedAt) return;
    const restored = await readJson(path.join(storePath, 'neurocenter-restored.json')).catch(() => null);
    if (restored?.fingerprintVersion !== 1 || restored.complete !== true || !Number.isSafeInteger(restored.rowCount) || restored.rowCount < 1
        || !/^[a-f0-9]{64}$/.test(restored.snapshotHash ?? '')
        || JSON.stringify(normalizeIndexProfile(restored.indexProfile)) !== JSON.stringify(expected.profile)) throw indexError();
}
