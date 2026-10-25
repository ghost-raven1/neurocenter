import { vi } from 'vitest';
import type { Request } from 'express';
import { ModelChatProjectContext } from '../../src/model-chat/chat-project-context';
import { ProjectEmbeddingRepository } from '../../src/models/project-embedding.repository';
import type { IModelInferenceRuntime } from '../../src/models/model-runtime';
import type { ModelsService } from '../../src/models/models.service';
import type { IModel } from '../../src/models/model.types';
import type { IProjectEmbeddingSelection } from '../../src/models/project-embedding.types';

export const embeddingModel: IModel = { id: 'model-context', name: 'Embedding', description: '', model: 'fixture:embedding', capability: 'embedding', runtime: 'ollama',
    dimension: 3, manifestSha256: 'd'.repeat(64), source: 'custom', revision: 1, createdAt: '', updatedAt: '' };
export const jsonResponse = (value: unknown, status = 200) => Response.json(value, { status });

/** Real context owner with controlled catalog ports; this fixture cannot open PostgreSQL or a network connection. */
export function projectContextPort(runtime: (models: ModelsService) => IModelInferenceRuntime, model: IModel = embeddingModel) {
    const project = { id: 'prj-context', name: 'Context', state: 'ACTIVE', headRevision: 1 };
    const selected: IProjectEmbeddingSelection = { projectId: project.id, revision: 1, dataRevision: 2, activeGeneration: 'initial-' + 'a'.repeat(32),
        activeSnapshot: 'b'.repeat(64), profile: { provider: 'openai', model: 'pinned-embedding', dimension: 3 }, expectedDimension: 3, modelPin: 'c'.repeat(64), model };
    const models = { pool: { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) }, resolveProject: vi.fn(async () => ({ ...project })) };
    vi.spyOn(ProjectEmbeddingRepository.prototype, 'read').mockImplementation(async () => selected);
    const inference = runtime(models as unknown as ModelsService), context = new ModelChatProjectContext(models as unknown as ModelsService, inference);
    vi.spyOn(context.client, 'call').mockImplementation(async () => ({ generation: selected.activeGeneration, snapshot: selected.activeSnapshot, sources: [] }) as never);
    const request = {} as Request, abort = new AbortController();
    return { context, selected, models, project, request, abort, inference, prepare: () => context.prepare(request, project.id, 'Question', abort.signal) };
}
