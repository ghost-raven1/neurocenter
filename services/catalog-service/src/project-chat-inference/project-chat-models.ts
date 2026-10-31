import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { canReadCommon } from '../access/access.model';
import { modelFromRow, type IModelRow } from '../models/model-history';
import type { IModel, IModelList } from '../models/model.types';
import type { ModelsService } from '../models/models.service';
import { validateModelId } from '../models/model-validation';
import type { ProjectChatDb } from '../project-chat/project-chat.types';
import { resolveProjectChatProject } from '../project-chat/project-chat-project';

/** Resolve models on the caller's connection, avoiding nested pool acquisition under a room lock. */
export function projectChatModels(models: ModelsService, db: ProjectChatDb): ModelsService {
    const resolveProject = (
        req: Request,
        id: string,
        minimum = 1,
        actor?: Parameters<ModelsService['resolveProject']>[3],
    ) => resolveProjectChatProject(models, db, req, id, minimum, actor);
    const get = async (id: string): Promise<IModel> => {
        validateModelId(id);
        const row = (await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR SHARE', [id])).rows[0];
        if (!row) throw new NotFoundException('Модель отсутствует в каталоге.');
        return modelFromRow(row);
    };
    const getUsable = async (id: string, req: Request, projectId?: string): Promise<IModel> => {
        if (!projectId) throw new ForbiddenException('Агентам общей комнаты нужен проект.');
        const project = await resolveProject(req, projectId, 2);
        if (
            !(
                await db.query('SELECT model_id FROM project_models WHERE project_id=$1 AND model_id=$2 FOR SHARE', [
                    project.id,
                    id,
                ])
            ).rowCount
        )
            throw new ForbiddenException('Модель не добавлена в каталог выбранного проекта.');
        return get(id);
    };
    const list = async (req: Request, projectId?: string): Promise<IModelList> => {
        if (!projectId) throw new ForbiddenException('Выберите проект общей комнаты.');
        const actor = await models.actor(req),
            project = await resolveProject(req, projectId, 1, actor);
        const assignedModelIds = (
            await db.query<{ model_id: string }>(
                'SELECT model_id FROM project_models WHERE project_id=$1 ORDER BY model_id',
                [project.id],
            )
        ).rows.map((row) => row.model_id);
        const common = canReadCommon(actor.claims, actor.activeRole);
        const rows = (
            await db.query<IModelRow>(
                'SELECT * FROM model_catalog WHERE (archived_at IS NULL OR id=ANY($1::text[])) AND ($2 OR id=ANY($1::text[])) ORDER BY lower(name),id',
                [assignedModelIds, common],
            )
        ).rows;
        return { items: rows.map(modelFromRow), assignedModelIds };
    };
    // This internal facade is used only by ChatGroup and approved learning, which need project identity.
    return Object.assign(Object.create(models) as ModelsService, { get, getUsable, list, resolveProject });
}
