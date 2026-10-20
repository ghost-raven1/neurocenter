import type { IModel } from './model.types';

/** Один локальный runtime tag навсегда соответствует одному manifest SHA, независимо от public name/head. */
export function localModelAlias(model: Pick<IModel, 'runtime' | 'manifestSha256'>): string {
    if (model.runtime !== 'ollama' || !/^[a-f0-9]{64}$/.test(model.manifestSha256 ?? '')) throw new Error('Импортируйте проверенный ассет модели с закреплённым SHA.');
    return `neurocenter/${model.manifestSha256}:v1`;
}
