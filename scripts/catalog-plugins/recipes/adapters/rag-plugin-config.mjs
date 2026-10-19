import { applyHostedRagConfiguration } from './rag-hosted.mjs';
export { applyHostedRagConfiguration } from './rag-hosted.mjs';
import { applyLocalRuntimeProfile } from './rag-local-runtime.mjs';
import { readFileSync } from 'node:fs';
import { managedEmbeddingConfiguration } from '../../../../services/shared/rag-index-contract.cjs';

/** Нужны исходные поля, поскольку upstream уже заполнил пропущенные значения своими defaults. */
export function readProjectRagConfiguration(file) {
    if (!file) return {};
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Проверьте JSON-настройки OpenCodeRAG.');
    return raw;
}

/** Сохраняет конфиг проекта; новый проект использует локальную модель без дополнительных моделей. */
export function managedRagConfiguration(config, rawConfiguration = {}, root) {
    let managed = structuredClone(config);
    // Старые вызывающие стороны передавали Boolean; true сохраняет весь явно переданный config.
    const raw = rawConfiguration === true ? config : rawConfiguration || {};
    managed.embedding = { ...managed.embedding, ...managedEmbeddingConfiguration(raw.embedding) };
    if (managed.embedding.provider === 'openai' && !managed.embedding.apiKey) {
        let url;
        try { url = new URL(managed.embedding.baseUrl); } catch { throw new Error('Проверьте адрес embedding-модели в настройках OpenCodeRAG.'); }
        if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port === '11435'
            && url.pathname.replace(/\/+$/, '') === '/v1' && !url.username && !url.password && !url.search && !url.hash) managed.embedding.apiKey = 'local';
    }
    managed.openCode = { ...managed.openCode, autoIndex: { ...managed.openCode.autoIndex, enabled: raw.openCode?.autoIndex?.enabled ?? true } };
    for (const name of ['description', 'imageDescription', 'decision', 'reranking']) {
        managed[name] = { ...managed[name], enabled: raw[name]?.enabled ?? false };
    }
    managed.autoUpdate = { ...managed.autoUpdate, enabled: false, autoInstall: false };
    return applyHostedRagConfiguration(applyLocalRuntimeProfile(managed), root);
}
