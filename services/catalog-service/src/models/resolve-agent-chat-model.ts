import { ConflictException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import type { IModel, IModelList } from './model.types';
import type { ModelsService } from './models.service';

/** Native aliases resolve only through an exact project source or a single assigned catalog identity. */
export async function resolveAgentChatModel(models: ModelsService, req: Request, projectId: string, selector: string | undefined,
    fallback: IModel | undefined, catalog: IModelList, db: Pick<PoolClient, 'query'> = models.pool, current?: (id: string) => Promise<IModel>): Promise<IModel> {
    const catalogId = selector?.startsWith('neurocenter/') ? selector.slice('neurocenter/'.length) : selector;
    let candidates = catalog.items.filter(model => catalog.assignedModelIds.includes(model.id) && (model.id === catalogId || model.model === selector));
    if (selector && !candidates.length) {
        const linked = (await db.query<{ model_id: string }>(`SELECT DISTINCT model_id FROM opencode_model_sources WHERE project_id=$1 AND state='present' AND provider||'/'||config_key=$2 AND model_id IS NOT NULL
            UNION SELECT model_id FROM model_device_connections WHERE revoked_at IS NULL AND (source->>'scope'='global' OR source->>'projectId'=$1)
                AND (expected_candidate->>'provider')||'/'||COALESCE(expected_candidate->>'configKey',expected_candidate->>'model')=$2`, [projectId, selector])).rows.map(row => row.model_id);
        candidates = catalog.items.filter(model => catalog.assignedModelIds.includes(model.id) && linked.includes(model.id));
    }
    let selected = fallback;
    if (selector) {
        const exact = candidates.find(candidate => candidate.id === catalogId);
        if (!exact && candidates.length !== 1) throw new ConflictException('Модель агента не связана с единственной моделью каталога проекта. Укажите neurocenter/<ID карточки модели> в настройках агента.');
        selected = exact ?? candidates[0];
    }
    if (!selected) throw new ConflictException('Выберите модель диалога из каталога проекта для этого испытания.');
    const model = await (current ? current(selected.id) : models.getUsable(selected.id, req, projectId));
    if (model.capability === 'embedding' || (model.runtime === 'ollama' ? !model.manifestSha256 : !model.verificationSha256)) throw new ConflictException('Выберите проверенную модель диалога для агента.');
    return model;
}
