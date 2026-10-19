import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeTarget } from '../../bridge/workspace-paths.js';
import { readBoundedUtf8 } from '../../bridge/read-bounded.js';
import { stateDir } from '../../bridge/state.js';
import {managedRagMcpEmbedding,type ManagedRagEmbedding} from '../rag-ui/managed-installation.js';
import type { IStoreLocateResult } from '../../lib/store.js';
import { normalizeIndexProfile, embeddingSignature, managedEmbeddingConfiguration, type IIndexProfile } from './contract.js';

async function json(root: string, relative: string): Promise<Record<string, unknown> | null> {
    try {
        const file = await safeTarget(root, relative);
        const value: unknown = JSON.parse(await readBoundedUtf8(file, 8 * 1024 * 1024));
        if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(); }
        return value as Record<string, unknown>;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; } throw new Error('Состояние индекса повреждено. Повторите индексацию в OpenCode.'); }
}
async function liveLock(root: string, relative: string, owned?: string): Promise<boolean> {
    const value = await json(root, relative);
    if (!value) { return false; }
    if (owned && JSON.stringify(value) === owned) { return false; }
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1) { throw new Error('Блокировка индекса повреждена. Закройте OpenCode и проверьте индекс.'); }
    try { process.kill(Number(value.pid), 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
/** Не выдаём неполный native-проход за авторитетную базу для удаления серверных строк. */
export async function assertIndexIdle(storePath: string, restore = false, ownedLock?: string): Promise<string> {
    if (await liveLock(storePath, 'index.lock', ownedLock)) { throw new Error('Идёт индексация OpenCodeRAG. Дождитесь её завершения.'); }
    if (restore && await liveLock(storePath, 'watcher.lock')) { throw new Error('Закройте OpenCode перед восстановлением базы знаний.'); }
    if (restore && await liveLock(storePath, 'neurocenter-session.lock')) { throw new Error('Закройте OpenCode перед восстановлением базы знаний, даже если автоиндексация выключена.'); }
    if (restore && await liveLock(storePath, 'neurocenter-ui-session.lock')) { throw new Error('Закройте интерфейс OpenCodeRAG перед восстановлением базы знаний.'); }
    const status = await json(storePath, 'watcher-status.json');
    if (restore) { return JSON.stringify(status); }
    const provenance = await json(storePath, 'neurocenter-index-profile.json');
    if (provenance?.schemaVersion !== 1 || provenance.state !== 'ready') {
        throw new Error('Происхождение векторов не подтверждено. Обновите OpenCodeRAG и дождитесь полной автоматической переиндексации.');
    }
    const proof = await json(storePath, 'neurocenter-restored.json');
    if (!status && proof?.fingerprintVersion === 1 && proof.complete === true) { return JSON.stringify({ ...proof, provenance }); }
    const manifest = await json(storePath, 'manifest.json');
    if (!manifest || Number(manifest.schemaVersion) < 3 || !Number.isFinite(manifest.lastIndexedAt) || Number(manifest.lastIndexedAt) <= 0
        || provenance.indexedAt !== manifest.lastIndexedAt) {
        throw new Error('Полный проход OpenCodeRAG не подтверждён. Запустите индексацию в OpenCode.');
    }
    if (!status) { return JSON.stringify([manifest, provenance]); }
    if (status.running !== false || !Number.isFinite(status.lastSuccessAt)
        || Number(status.lastSuccessAt) < Number(status.lastRunAt ?? 0)
        || Number(status.lastSuccessAt) < Number(status.lastChangeAt ?? 0)
        || Number(status.consecutiveFailures ?? 0) !== 0 || Number(status.lastPassProblems ?? 0) !== 0
        || Number(status.lastErrorAt ?? 0) > Number(status.lastSuccessAt)) {
        throw new Error('Индекс ещё не готов: дождитесь полного успешного прохода OpenCodeRAG без ошибок.');
    }
    return JSON.stringify([status, manifest, provenance]);
}
async function managedNative(root: string): Promise<{embedding:ManagedRagEmbedding}|undefined> {
    const directory = await safeTarget(root, '.opencode/neurocenter/receipts');
    let files: string[];
    try { files = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
    const marker=await json(root,'.opencode/neurocenter.json');
    let plugin=false;
    for (const name of files.filter(name => /^[a-f0-9]{24}\.json$/.test(name))) {
        const receipt = await json(root, '.opencode/neurocenter/receipts/' + name);
        if(typeof marker?.projectId==='string'){
            const embedding=await managedRagMcpEmbedding(root,marker.projectId,name.slice(0,-5),receipt);
            if(embedding)return {embedding};
        }
        const config = receipt?.config as { key?: unknown; value?: unknown } | undefined;
        if (config?.key !== 'plugin' || typeof config.value !== 'string' || !/^[a-f0-9]{64}$/.test(String(receipt?.manifest))
            || !Number.isSafeInteger(receipt?.version)) { continue; }
        try {
            const url = new URL(config.value);
            if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) { continue; }
            const relative = path.relative(path.join(stateDir(), 'runtime-artifacts'), fileURLToPath(url)).split(path.sep).join('/');
            if (/^[a-f0-9]{64}\/rag-plugin\.mjs$/.test(relative)) { plugin=true; }
        } catch { /* Посторонний плагин не задаёт профиль embedding-модели. */ }
    }
    return plugin?{embedding:{}}:undefined;
}
/** Название модели не восстанавливается по размерности: разные модели несовместимы и при одинаковом числе координат. */
export async function localEmbeddingIdentity(located: IStoreLocateResult, dimension?: number): Promise<{ profile: IIndexProfile; signature: string }> {
    if (located.configPath) {
        const relative = path.relative(located.root, located.configPath).split(path.sep).join('/');
        await safeTarget(located.root, relative);
    }
    const embedding = located.config?.embedding;
    const managed = await managedNative(located.root);
    const effective = managed ? managedEmbeddingConfiguration({...located.config?.embeddingInput,...managed.embedding}) : embedding;
    let profile: IIndexProfile | null = null;
    let baseUrl = effective?.baseUrl ?? 'http://127.0.0.1:11434/api';
    if (effective) {
        profile = normalizeIndexProfile({ provider: effective.provider || 'ollama', model: effective.model || 'qwen3-embedding:0.6b', dimension: effective.vectorDimension ?? dimension });
    }
    const overrides = located.storePath ? await json(located.storePath, 'runtime-overrides.json') : null;
    const runtime = overrides?.embedding as { provider?: unknown; model?: unknown; baseUrl?: unknown } | undefined;
    if (profile && runtime) { profile = normalizeIndexProfile({ ...profile, provider: runtime.provider ?? profile.provider, model: runtime.model ?? profile.model }); }
    if (runtime?.baseUrl !== undefined) {
        if (typeof runtime.baseUrl !== 'string') { throw new Error('Некорректный адрес embedding-модели в настройках OpenCodeRAG.'); }
        baseUrl = runtime.baseUrl;
    }
    if (!profile || (dimension !== undefined && profile.dimension !== dimension)) {
        throw new Error('Профиль embedding-модели не подтверждён или размерность индекса отличается. Проверьте настройки OpenCodeRAG и переиндексируйте проект.');
    }
    return { profile, signature: embeddingSignature(profile, baseUrl) };
}
export async function localIndexProfile(located: IStoreLocateResult, dimension?: number): Promise<IIndexProfile> {
    return (await localEmbeddingIdentity(located, dimension)).profile;
}
/** Профиль привязан к завершённому native-проходу, включая локальный адрес модели без секретов. */
export async function assertVerifiedIndex(located: IStoreLocateResult, dimension: number): Promise<IIndexProfile> {
    const expected = await localEmbeddingIdentity(located, dimension);
    const record = await json(located.storePath!, 'neurocenter-index-profile.json');
    assertSameProfile(expected.profile, normalizeIndexProfile(record?.profile));
    if (record?.schemaVersion !== 1 || record.state !== 'ready' || record.embeddingSignature !== expected.signature) {
        throw new Error('Модель или подключение изменились после индексации. Дождитесь полной переиндексации OpenCodeRAG.');
    }
    return expected.profile;
}
export function assertSameProfile(left: IIndexProfile, right: IIndexProfile | null): void {
    if (!right || left.provider !== right.provider || left.model !== right.model || left.dimension !== right.dimension) {
        throw new Error('Модели локального и серверного индексов различаются. Используйте одну модель и выполните полную индексацию.');
    }
}
