import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { AccessDb } from '../access/access-db';
import { canReadCommon, projectLevel, type IAccessClaims } from '../access/access.model';
import { CatalogService } from '../catalog/catalog.service';
import type { IProjectDetail } from '../catalog/dto';
import { createPool } from '../database/pool';
import { readModelActor, type IModelActor } from './model-access';
import type { IModel, IModelList, IModelVerification } from './model.types';
import { notifyModelCatalogChange } from './model-events';
import { validateModelId } from './model-validation';
import { ModelsRepository } from './models.repository';

/** Реестр моделей не зависит от моста и не передаёт его установщику новые типы инструментов. */
@Injectable()
export class ModelsService implements OnModuleInit, OnApplicationShutdown {
    readonly pool = createPool({ connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 5 }, 'models');
    private readonly repository = new ModelsRepository(this.pool);

    constructor(private readonly catalog: CatalogService, private readonly access: AccessDb) {}
    ready(): Promise<void> { return this.catalog.ensureSchema(); }
    async onModuleInit(): Promise<void> { await this.ready(); }
    async onApplicationShutdown(): Promise<void> { await this.pool.end(); }
    actor(req: Request): Promise<IModelActor> { return readModelActor(req, this.access); }

    async requireMain(req: Request): Promise<string> {
        const actor = await this.actor(req);
        if (actor.activeRole !== 'Главный админ') { throw new ForbiddenException('Управлять общим каталогом и хостингом моделей может главный администратор.'); }
        return actor.email;
    }

    async get(id: string): Promise<IModel> {
        validateModelId(id);
        const card = await this.repository.get(id);
        if (!card) { throw new NotFoundException('Модель отсутствует в каталоге.'); }
        return card;
    }

    async getAccessible(id: string, req: Request): Promise<IModel> {
        const actor = await this.actor(req);
        if (!canReadCommon(actor.claims, actor.activeRole)) {
            const allowed = await this.repository.accessibleIds(this.projectIds(actor.claims, actor.activeRole));
            if (!allowed.includes(id)) { throw new ForbiddenException('Модель не добавлена в каталог доступного проекта.'); }
        }
        return this.get(id);
    }

    /** Для inference требуется рабочая роль именно в проекте, которому назначена модель. */
    async getUsable(id: string, req: Request, projectId?: string): Promise<IModel> {
        const actor = await this.actor(req);
        if (projectId !== undefined) {
            const project = await this.resolveProject(req, projectId, 2, actor);
            if (!await this.isAssigned(project.id, id)) { throw new ForbiddenException('Модель не добавлена в каталог выбранного проекта.'); }
        } else if (actor.activeRole !== 'Главный админ') {
            const allowed = await this.repository.accessibleIds(this.projectIds(actor.claims, actor.activeRole, 2));
            if (!allowed.includes(id)) { throw new ForbiddenException('Для использования модели нужна рабочая роль в проекте, которому она назначена.'); }
        }
        return this.get(id);
    }

    async resolveProject(req: Request, idOrName: string, minimumLevel = 1, actor?: IModelActor): Promise<IProjectDetail> {
        if (typeof idOrName !== 'string' || !idOrName.trim() || idOrName.length > 256) { throw new BadRequestException('Выберите проект.'); }
        const current = actor ?? await this.actor(req);
        if (projectLevel(current.claims, current.activeRole, idOrName) < minimumLevel) { throw new ForbiddenException('Активная роль не разрешает это действие в выбранном проекте.'); }
        const project = await this.catalog.getProject(idOrName);
        if (projectLevel(current.claims, current.activeRole, project.id) < minimumLevel) { throw new ForbiddenException('Нет доступа к выбранному проекту.'); }
        return project;
    }

    async list(req: Request, projectId?: string): Promise<IModelList> {
        const actor = await this.actor(req);
        let assignedModelIds: string[] = [];
        let allowedIds: string[] | undefined;
        if (projectId !== undefined) {
            const project = await this.resolveProject(req, projectId, 1, actor);
            assignedModelIds = await this.repository.accessibleIds([project.id]);
            if (!canReadCommon(actor.claims, actor.activeRole)) { allowedIds = assignedModelIds; }
        } else if (!canReadCommon(actor.claims, actor.activeRole)) {
            allowedIds = await this.repository.accessibleIds(this.projectIds(actor.claims, actor.activeRole));
        }
        return { items: await this.repository.list(allowedIds), assignedModelIds };
    }

    isAssigned(projectId: string, modelId: string): Promise<boolean> { return this.repository.isAssigned(projectId, modelId); }
    create(raw: unknown, actor: string): Promise<IModel> { return this.repository.create(raw, actor); }
    update(id: string, raw: unknown, actor: string): Promise<IModel> { validateModelId(id); return this.repository.update(id, raw, actor); }
    /** Доверенные метаданные runtime фиксируются до инвалидации клиентского каталога. */
    async pinVerified(expected: IModel, verified: IModelVerification, actor: string, authorize: () => Promise<void>): Promise<IModel> {
        const saved = await this.repository.pinVerified(expected, verified, actor, authorize);
        if (saved.revision !== expected.revision) { await notifyModelCatalogChange(); }
        return saved;
    }
    remove(id: string, raw: unknown, actor: string): Promise<void> { validateModelId(id); return this.repository.remove(id, raw, actor); }
    assign(projectId: string, modelId: string, actor: string): Promise<void> { validateModelId(modelId); return this.repository.assign(projectId, modelId, actor); }
    unassign(projectId: string, modelId: string, actor: string): Promise<boolean> { validateModelId(modelId); return this.repository.unassign(projectId, modelId, actor); }

    private projectIds(claims: IAccessClaims, activeRole: string, minimumLevel = 1): string[] {
        return claims.projects.filter(project => projectLevel(claims, activeRole, project.projectId) >= minimumLevel).map(project => project.projectId);
    }
}
