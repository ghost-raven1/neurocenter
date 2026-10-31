import type { IModel } from './model.types';

/** Один локальный runtime tag навсегда соответствует одному manifest SHA, независимо от public name/head. */
export function localModelAlias(model: Pick<IModel, 'runtime' | 'manifestSha256' | 'fileImport'>): string {
    if (
        model.runtime === 'ollama' &&
        model.fileImport &&
        /^[a-f0-9]{64}$/.test(model.fileImport.sha256) &&
        /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(model.fileImport.uploadId)
    )
        return `neurocenter/gguf-${model.fileImport.uploadId}:v1`;
    if (model.runtime !== 'ollama' || !/^[a-f0-9]{64}$/.test(model.manifestSha256 ?? ''))
        throw new Error('Импортируйте проверенный ассет модели с закреплённым SHA.');
    return `neurocenter/${model.manifestSha256}:v1`;
}
