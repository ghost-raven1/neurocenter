import { applyLocalRuntimeProfile } from './rag-local-runtime.mjs';

/** Сохраняет конфиг проекта; новый проект использует локальную модель без дополнительных моделей. */
export function managedRagConfiguration(config, hasProjectConfiguration) {
    let managed = structuredClone(config);
    if (!hasProjectConfiguration) {
        managed.embedding = { ...managed.embedding, provider: 'ollama', baseUrl: 'http://127.0.0.1:11435/api', model: 'qwen3-embedding:4b', vectorDimension: 2560 };
        managed.openCode = { ...managed.openCode, autoIndex: { ...managed.openCode.autoIndex, enabled: true } };
        for (const name of ['description', 'imageDescription', 'decision', 'reranking']) {
            managed[name] = { ...managed[name], enabled: false };
        }
    }
    managed.autoUpdate = { ...managed.autoUpdate, enabled: false, autoInstall: false };
    return applyLocalRuntimeProfile(managed);
}
