import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { roleLevel } from '../access/access.model';
import type { IModelActor } from '../models/model-access';
import type { ModelsService } from '../models/models.service';
import { modelFromRow, type IModelRow } from '../models/model-history';
import { ProjectAgentRepository } from '../agents/project-agent.repository';
import type { ProjectAgentAssignment } from '../agents/agent.types';
import { ProjectEmbeddingRepository } from '../models/project-embedding.repository';
import { projectEmbeddingPin } from '../models/project-embedding.validation';
import { resolveAgentChatModel } from '../models/resolve-agent-chat-model';
import type { IModel, IModelList } from '../models/model.types';
import type { TrialDb, TrialRow } from './agent-readiness.repository';
import { trialHash } from './agent-readiness.validation';

export const agentTrialPin = (agent: ProjectAgentAssignment): string => trialHash({ id: agent.agentId, version: agent.version, manifest: agent.manifest, definition: agent.effective });
export class AgentTrialPolicy {
    readonly agents: ProjectAgentRepository;
    readonly embedding: ProjectEmbeddingRepository;
    constructor(readonly models: ModelsService) { this.agents = new ProjectAgentRepository(models.pool); this.embedding = new ProjectEmbeddingRepository(models.pool); }
    async actor(req: Request, projectId: string): Promise<IModelActor> {
        if (req.headers['x-neurocenter-device-id']) throw new ForbiddenException('Испытание запускает пользователь в интерфейсе.');
        const actor = await this.models.actor(req), project = await this.models.resolveProject(req, projectId, 2, actor);
        if (project.id !== projectId) throw new ForbiddenException('Выберите точный идентификатор проекта.'); return actor;
    }
    async authorize(db: TrialDb, actor: IModelActor, project: string): Promise<void> {
        const account = (await db.query<{ enabled: boolean; is_main_admin: boolean }>('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE', [actor.email])).rows[0];
        if (!account?.enabled) throw new ForbiddenException('Учётная запись отключена.');
        if (actor.activeRole === 'Главный админ') { if (account.is_main_admin) return; throw new ForbiddenException('Права главного администратора отозваны.'); }
        const grant = (await db.query<{ role: string }>('SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=$2 FOR SHARE', [project, actor.email])).rows[0];
        if (Math.min(roleLevel(grant?.role), roleLevel(actor.activeRole)) < 2) throw new ForbiddenException('Для испытания нужна рабочая роль в проекте.');
    }
    async assignment(project: string, id: string, db: TrialDb = this.models.pool): Promise<ProjectAgentAssignment> {
        const agent = (await this.agents.assignments(project, db)).find(row => row.agentId === id);
        if (!agent || agent.removed || (await this.agents.cards.get(id, db)).archivedAt) throw new NotFoundException('Агент больше не доступен для испытания в проекте.'); return agent;
    }
    async model(req: Request, project: string, agent: ProjectAgentAssignment, id: string, catalog?: IModelList, db?: TrialDb): Promise<IModel> {
        const rows = !catalog && db ? (await db.query<IModelRow>('SELECT m.* FROM model_catalog m JOIN project_models p ON p.model_id=m.id WHERE p.project_id=$1 ORDER BY m.id', [project])).rows.map(modelFromRow) : null;
        const choices = catalog ?? (rows ? { items: rows, assignedModelIds: rows.map(model => model.id) } : await this.models.list(req, project));
        const fallback = choices.items.find(model => model.id === id && choices.assignedModelIds.includes(id));
        const current = db ? async (selected: string) => {
            const match = choices.items.find(model => model.id === selected && choices.assignedModelIds.includes(selected));
            if (!match) throw new ConflictException('Модель больше не назначена проекту.'); return match;
        } : undefined;
        const model = await resolveAgentChatModel(this.models, req, project, agent.effective.model, fallback, choices, db, current);
        if (model.id !== id) throw new ConflictException('Закреплённую модель агента нельзя заменить моделью испытания.'); return model;
    }
    async tool(project: string, agent: ProjectAgentAssignment, db: TrialDb = this.models.pool): Promise<{ available: boolean; requiresConsent: boolean; reason?: string; pin: string | null }> {
        const permission = agent.effective.permission?.read;
        if (permission !== 'allow' && permission !== 'ask') return { available: false, requiresConsent: false, reason: 'В настройках агента нет разрешения на чтение проекта.', pin: null };
        if (db !== this.models.pool) {
            await db.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [project]);
            await db.query('SELECT project_id FROM project_embedding_settings WHERE project_id=$1 FOR SHARE', [project]);
        }
        const selected = await this.embedding.read(project, db);
        if (db !== this.models.pool && selected.model) {
            await db.query('SELECT id FROM model_catalog WHERE id=$1 FOR SHARE', [selected.model.id]);
            await db.query('SELECT model_id FROM project_models WHERE project_id=$1 AND model_id=$2 FOR SHARE', [project, selected.model.id]);
        }
        const pending = await db.query("SELECT 1 FROM project_rag_sync_intents WHERE project_id=$1 AND state IN ('pending','uncertain') LIMIT 1", [project]);
        const available = !selected.blocker && !!selected.model && !!selected.profile && !!selected.activeSnapshot && !pending.rowCount;
        return { available, requiresConsent: permission === 'ask', ...(!available ? { reason: selected.blocker ?? 'Нужен полностью синхронизированный индекс проекта.' } : {}),
            pin: available ? trialHash({ revision: selected.revision, dataRevision: selected.dataRevision, generation: selected.activeGeneration, snapshot: selected.activeSnapshot, profile: selected.profile, modelPin: selected.modelPin }) : null };
    }
    /** Share locks fence role, assignment and model edits through the terminal receipt commit. */
    async assertCurrent(req: Request, row: TrialRow, db: TrialDb): Promise<IModel> {
        const actor = await this.actor(req, row.project_id);
        if (actor.email !== row.owner_email) throw new ForbiddenException('Владелец испытания изменился.');
        await this.authorize(db, actor, row.project_id);
        await db.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [row.project_id]);
        await db.query('SELECT project_id FROM project_agent_sets WHERE project_id=$1 FOR SHARE', [row.project_id]);
        await db.query('SELECT id FROM agent_catalog WHERE id=$1 FOR SHARE', [row.agent_id]);
        await db.query('SELECT model_id FROM project_models WHERE project_id=$1 AND model_id=$2 FOR SHARE', [row.project_id, row.receipt.modelId]);
        const current = (await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR SHARE', [row.receipt.modelId])).rows[0];
        if (!current || projectEmbeddingPin(modelFromRow(current)) !== row.receipt.modelPin) throw new ConflictException('Модель испытания изменилась.');
        const agent = await this.assignment(row.project_id, row.agent_id, db);
        if (agentTrialPin(agent) !== row.snapshot.agentPin) throw new ConflictException('Промпт или настройки агента изменились.');
        const model = await this.model(req, row.project_id, agent, row.receipt.modelId, undefined, db);
        if (projectEmbeddingPin(model) !== row.receipt.modelPin) throw new ConflictException('Модель испытания изменилась.');
        if (row.request.tool === 'project_search') {
            const tool = await this.tool(row.project_id, agent, db);
            if (!tool.available || tool.pin !== row.snapshot.toolPin || tool.requiresConsent && !row.request.toolConsent) throw new ConflictException('Разрешение или индекс проекта изменились.');
        }
        return model;
    }
}
