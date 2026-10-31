import { assertChatSystemRoleOrigin } from '../chat-system-roles/chat-system-roles.origin-policy';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { ModelsService } from '../models/models.service';
import type { IModelActor } from '../models/model-access';
import { modelFromRow, type IModelRow } from '../models/model-history';
import { authorizeAgentWrite } from '../agents/agent-access';
import { projectEmbeddingPin } from '../models/project-embedding.validation';
import { roleDefinitionPin } from './system-role.definitions';
import { acceptedLegacyDefinition } from './system-role.legacy-contract';
import { acceptedPreviousDefinition } from './system-role.previous-contract';
import type { RoleDb } from './system-role.repository';
import type { RoleRunRow, StartRoleRun, SystemRoleId } from './system-role.types';

/** Current human authority and exact model identity are checked again after admission/rate waits. */
export class SystemRolePolicy {
    constructor(readonly models: ModelsService) {}
    async actor(req: Request, project: string | null, minimum = 3): Promise<IModelActor> {
        if (req.headers['x-neurocenter-device-id'])
            throw new ForbiddenException('Системного агента запускает пользователь в интерфейсе.');
        const actor = await this.models.actor(req);
        if (project) {
            const selected = await this.models.resolveProject(req, project, minimum, actor);
            if (selected.id !== project) throw new ForbiddenException('Выберите точный ID проекта.');
        } else if (actor.activeRole !== 'Главный админ')
            throw new ForbiddenException('Диагностика площадки доступна главному администратору.');
        return actor;
    }
    async authorize(db: RoleDb, actor: IModelActor, project: string | null): Promise<void> {
        await authorizeAgentWrite(db, actor, project ?? undefined);
        if (project && !(await db.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [project])).rowCount)
            throw new ConflictException('Проект недоступен.');
    }
    async model(req: Request, id: string, project: string | null, expected?: string) {
        const actor = await this.actor(req, project),
            model = await this.models.getUsable(
                id,
                req,
                actor.activeRole === 'Главный админ' ? undefined : (project ?? undefined),
            );
        this.validModel(model, expected);
        return model;
    }
    private validModel(model: ReturnType<typeof modelFromRow>, expected?: string): void {
        if (
            model.archivedAt ||
            !['chat', 'vision'].includes(model.capability) ||
            !(model.runtime === 'ollama' ? model.manifestSha256 : model.verificationSha256) ||
            (expected && projectEmbeddingPin(model) !== expected)
        )
            throw new ConflictException('Выберите актуальную проверенную модель диалога с точным pin.');
    }
    async current(req: Request, row: RoleRunRow, db: RoleDb) {
        const actor = await this.actor(req, row.project_id);
        if (actor.email !== row.actor || actor.activeRole !== row.actor_role)
            throw new ForbiddenException('Исполнитель задания изменился.');
        await this.authorize(db, actor, row.project_id);
        if (
            row.snapshot.definitionPin !== row.request.expectedDefinitionPin ||
            row.snapshot.consentDigest !== row.request.consentDigest ||
            (roleDefinitionPin(row.agent_id) !== row.request.expectedDefinitionPin &&
                !acceptedLegacyDefinition(row) &&
                !acceptedPreviousDefinition(row))
        )
            throw new ConflictException('Определение системного агента изменилось.');
        await this.source(db, actor.email, row.agent_id, row.request, row.request_hash);
        return this.modelInTransaction(db, actor, row.project_id, row.request.modelId, row.request.expectedModelPin);
    }
    /** A chat turn is an immutable accepted intent, never a second queue. Cancellation fences the physical request. */
    async source(db: RoleDb, actor: string, id: SystemRoleId, input: StartRoleRun, hash: string): Promise<void> {
        if (!input.source) return;
        const source = input.source;
        const accepted = await db.query(
            `SELECT i.id FROM system_role_dialog_intents i JOIN system_role_dialogs d ON d.id=i.dialog_id
            WHERE i.id=$1 AND i.dialog_id=$2 AND i.owner_email=$3 AND d.owner_email=$3 AND i.request_id=$4 AND i.agent_id=$5
            AND i.request_hash=$6 AND d.project_id IS NOT DISTINCT FROM $7 AND NOT i.cancel_requested FOR SHARE OF i,d`,
            [source.turnId, source.dialogId, actor, input.requestId, id, hash, input.projectId],
        );
        if (!accepted.rowCount) throw new ConflictException('Сообщение системного чата отменено или изменилось.');
        await assertChatSystemRoleOrigin(db, source.dialogId, actor, input.projectId);
    }
    async modelInTransaction(db: RoleDb, actor: IModelActor, project: string | null, id: string, pin: string) {
        if (
            project &&
            actor.activeRole !== 'Главный админ' &&
            !(
                await db.query('SELECT model_id FROM project_models WHERE project_id=$1 AND model_id=$2 FOR SHARE', [
                    project,
                    id,
                ])
            ).rowCount
        )
            throw new ForbiddenException('Модель больше не назначена проекту.');
        const current = (await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR SHARE', [id])).rows[0];
        if (!current) throw new ConflictException('Модель больше не доступна.');
        const model = modelFromRow(current);
        this.validModel(model, pin);
        return model;
    }
    async read(req: Request, row: RoleRunRow): Promise<IModelActor> {
        const actor = await this.actor(req, row.project_id, 1);
        if (row.request.source?.kind === 'system-role-chat' && actor.email !== row.actor)
            throw new NotFoundException('Личный запуск сервисного чата недоступен.');
        if (actor.email !== row.actor) await this.actor(req, row.project_id, 3);
        return actor;
    }
}
