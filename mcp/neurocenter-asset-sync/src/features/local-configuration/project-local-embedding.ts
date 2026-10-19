import type { LocalConfigurationSchema } from './schema.js';

/** Только идентификаторы известных полей RAG: значения и секреты сюда не входят. */
export function projectLocalEmbeddingFields(schema: LocalConfigurationSchema): {url: string; model: string; provider: string} | undefined {
    const field = (name: string, type: 'url' | 'string') => schema.fields.find(item => item.target.kind === 'env'
        && item.target.name === name && item.target.prefix === undefined && item.type === type && !item.secret);
    const url = field('NEUROCENTER_RAG_EMBEDDING_URL', 'url');
    const model = field('NEUROCENTER_RAG_EMBEDDING_MODEL', 'string');
    const provider = field('NEUROCENTER_RAG_EMBEDDING_PROVIDER', 'string');
    return url && model && provider ? {url: url.id, model: model.id, provider: provider.id} : undefined;
}
