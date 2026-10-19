import type { IModelDescriptor } from './model.types';

/** Закреплённые модели совпадают с scripts/embedding и scripts/vision/model.lock.json. */
export const builtinModels: ReadonlyArray<{ id: string; name: string; descriptor: IModelDescriptor }> = [
    { id: 'model-embedding-qwen3-4b', name: 'Qwen3 Embedding 4B', descriptor: {
        description: 'Локальная embedding-модель для поиска по смыслу и базы знаний проекта. Веса и runtime размещаются на сервере Нейроцентра.',
        capability: 'embedding', runtime: 'ollama', model: 'qwen3-embedding:4b',
        manifestSha256: 'df5bd2e3c74cd8d069d21dc038f1b359fcdc9458fce1c99bd43c9eb1518ff907', dimension: 2560, source: 'builtin',
    } },
    { id: 'model-vision-qwen3-vl-2b', name: 'Qwen3 VL 2B Instruct', descriptor: {
        description: 'Локальная vision-модель для описания изображений. Веса и runtime размещаются на сервере Нейроцентра.',
        capability: 'vision', runtime: 'ollama', model: 'qwen3-vl:2b-instruct',
        manifestSha256: 'afc393e3572c07db0bc84aa460d928a16c75f3fbb9ca9e0dccc4fbd2dafb573e', dimension: null, source: 'builtin',
    } },
];
