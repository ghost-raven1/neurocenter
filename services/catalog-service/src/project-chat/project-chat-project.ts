import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { projectLevel } from '../access/access.model';
import type { IProjectDetail } from '../catalog/dto';
import type { IModelActor } from '../models/model-access';
import type { ModelsService } from '../models/models.service';
import type { ProjectChatDb } from './project-chat.types';

export type ProjectChatIdentity = Pick<IProjectDetail, 'id' | 'name' | 'state'>;
/** Chat admission needs identity and current grants, never filesystem or RAG size measurements. */
export async function resolveProjectChatProject(models: Pick<ModelsService, 'actor'>, db: ProjectChatDb, req: Request,
    idOrName: string, minimum = 1, actor?: IModelActor): Promise<ProjectChatIdentity> {
    if (typeof idOrName !== 'string' || !idOrName.trim() || idOrName.length > 256) throw new BadRequestException('Выберите проект.');
    const current = actor ?? await models.actor(req);
    if (projectLevel(current.claims, current.activeRole, idOrName) < minimum) throw new ForbiddenException('Активная роль не разрешает это действие в проекте.');
    const row = (await db.query<ProjectChatIdentity>("SELECT id,name,state FROM projects WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'prj-%') ORDER BY (id=$1) DESC LIMIT 1", [idOrName])).rows[0];
    if (!row) throw new NotFoundException('Проект удалён.');
    if (projectLevel(current.claims, current.activeRole, row.id) < minimum) throw new ForbiddenException('Нет доступа к выбранному проекту.');
    if (minimum > 1 && row.state !== 'ACTIVE') throw new ForbiddenException('Проект доступен только для чтения.');
    return row;
}
