import {assertChatSystemRoleOrigin} from '../chat-system-roles/chat-system-roles.origin-policy';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { ModelsService } from '../models/models.service';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { roleHash, systemRole } from '../system-roles/system-role.definitions';
import { SystemRoleService } from '../system-roles/system-role.service';
import { roleAction, roleRequestId } from '../system-roles/system-role.validation';
import { SystemRoleChatRepository } from './system-role-chat.repository';
import { chatProject, chatRole, createSystemDialog, prepareSystemTurn, sendSystemTurn } from './system-role-chat.validation';
import { systemDialogContext } from './system-role-chat.context';
import type { SystemDialog, SystemDialogRow, SystemTurn, SystemTurnRow } from './system-role-chat.types';

/** Private durable conversations project the existing bounded role workflow and its owner operations. */
@Injectable()
export class SystemRoleChatService {
    readonly repository: SystemRoleChatRepository;
    constructor(private readonly models: ModelsService, private readonly roles: SystemRoleService) {
        this.repository = new SystemRoleChatRepository(models.pool);
    }
    async list(req: Request, projectId?: string, rawAgent?: unknown): Promise<SystemDialog[]> {
        await this.models.ready(); const project = chatProject(projectId), agent = chatRole(rawAgent), actor = await this.roles.policy.actor(req, project, 1);
        return (await this.repository.dialogs(actor.email, project, agent)).map(row => this.dialogView(row, agent));
    }
    async create(req: Request, raw: unknown): Promise<SystemDialog> {
        await this.models.ready(); const input = createSystemDialog(raw), actor = await this.roles.policy.actor(req, input.projectId, 1);
        const old = (await this.models.pool.query<SystemDialogRow>('SELECT * FROM system_role_dialogs WHERE id=$1 AND owner_email=$2', [input.id, actor.email])).rows[0];
        if (old) {
            if (old.title !== input.title || old.project_id !== input.projectId || (old.agent_id ?? null) !== input.agentId) throw new ConflictException('Ключ диалога относится к другому выбору.');
            return this.dialogView(old);
        }
        await this.roles.policy.actor(req, input.projectId);
        await requireFeaturesEnabled(['system_role_chat', ...(input.agentId ? ['service_role_conversations' as const] : [])]);
        const row = await this.roles.repository.transaction(async db => {
            await this.roles.policy.authorize(db, actor, input.projectId);
            await db.query(`INSERT INTO system_role_dialogs(id,owner_email,project_id,title,agent_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`, [input.id, actor.email, input.projectId, input.title, input.agentId]);
            const saved = await this.repository.dialog(input.id, actor.email, db);
            if (saved.title !== input.title || saved.project_id !== input.projectId || (saved.agent_id ?? null) !== input.agentId) throw new ConflictException('Ключ диалога относится к другому выбору.');
            return saved;
        });
        return this.dialogView(row);
    }
    async detail(req: Request, dialogId: string, rawAgent?: unknown) {
        const dialog = await this.owned(req, dialogId), agent = chatRole(rawAgent);
        if (agent) this.assertRole(dialog, agent);
        const turns = await this.repository.turns(dialog.id, dialog.owner_email, agent);
        return { dialog: this.dialogView(dialog, agent), turns: await Promise.all(turns.map(row => this.turnView(req, row))) };
    }
    async request(req: Request, dialogId: string, requestId: string): Promise<SystemTurn> {
        const dialog = await this.owned(req, dialogId), turn = await this.repository.turn(dialog.id, dialog.owner_email, roleRequestId(requestId));
        if (!turn) throw new NotFoundException('Принятое сообщение не найдено.');
        return this.turnView(req, turn);
    }
    async prepare(req: Request, dialogId: string, raw: unknown) {
        const dialog = await this.owned(req, dialogId, 3), { agentId, selection, includeContext } = prepareSystemTurn(raw);
        this.scope(dialog, selection.projectId); this.assertRole(dialog, agentId); this.requirePinned(dialog);
        if (selection.targets.some(target => target.kind === 'dialog-context')) throw new ConflictException('Контекст диалога выбирается отдельным подтверждением.');
        await this.assertOrigin(req, dialog);
        await requireFeaturesEnabled(['system_role_chat', systemRole(agentId).flag, ...(dialog.agent_id ? ['service_role_conversations' as const] : [])]);
        if (includeContext) {
            const id = randomUUID();
            await this.roles.repository.transaction(async db => {
                const actor = await this.roles.policy.actor(req, dialog.project_id);
                await this.roles.policy.authorize(db, actor, dialog.project_id);
                await this.repository.dialog(dialog.id, actor.email, db, true);
                await assertChatSystemRoleOrigin(db, dialog.id, actor.email, dialog.project_id);
                const context = await systemDialogContext(db, actor.email, dialog.id);
                await db.query('INSERT INTO system_role_dialog_contexts(id,dialog_id,owner_email,refs,pin) VALUES($1,$2,$3,$4::jsonb,$5)', [id, dialog.id, actor.email, JSON.stringify(context.references), context.pin]);
            });
            selection.targets.push({ kind: 'dialog-context', id });
        }
        // The role owner validates target count, live versions and preview digest again on start.
        const prepared = await this.roles.prepare(req, agentId, selection);
        return { selection, prepared };
    }
    async send(req: Request, dialogId: string, raw: unknown): Promise<SystemTurn> {
        const dialog = await this.owned(req, dialogId), { agentId, input } = sendSystemTurn(dialog.id, raw);
        this.scope(dialog, input.projectId); this.assertRole(dialog, agentId); const hash = roleHash({ id: agentId, input });
        const old = await this.repository.turn(dialog.id, dialog.owner_email, input.requestId);
        if (old) {
            if (old.request_hash !== hash) throw new ConflictException('Ключ сообщения относится к другому запросу.');
            return this.turnView(req, old);
        }
        this.requirePinned(dialog);
        await this.roles.policy.actor(req, dialog.project_id);
        if (dialog.agent_id) await requireFeaturesEnabled(['service_role_conversations']);
        await this.assertOrigin(req, dialog);
        const contexts = input.targets.filter(target => target.kind === 'dialog-context');
        if (contexts.length && (contexts.length !== 1 || !(await this.models.pool.query('SELECT id FROM system_role_dialog_contexts WHERE id::text=$1 AND dialog_id=$2 AND owner_email=$3', [contexts[0].id, dialog.id, dialog.owner_email])).rowCount)) throw new ConflictException('Подтвердите контекст этого диалога заново.');
        const run = await this.roles.start(req, agentId, input, {
            before: async db => {
                await this.repository.dialog(dialog.id, dialog.owner_email, db, true);
                await this.repository.accept(db, dialog, agentId, input, hash);
            },
            accepted: (db, row) => this.repository.attach(db, row),
        });
        // Return the committed receipt directly: a second post-commit ACL check must not misreport accepted work as a rejected POST.
        return { id: input.requestId, agentId, instruction: input.instruction, createdAt: run.createdAt, cancelRequested: run.state === 'cancelled', run };
    }
    async cancel(req: Request, dialogId: string, turnId: string, raw: unknown): Promise<SystemTurn> {
        const dialog = await this.owned(req, dialogId), action = roleAction(raw), turn = await this.repository.turn(dialog.id, dialog.owner_email, roleRequestId(turnId));
        if (!turn) throw new NotFoundException('Сообщение недоступно.');
        const run = await this.roles.cancel(req, turn.agent_id, turn.run_id, action);
        if (run.state === 'cancelled') await this.models.pool.query('UPDATE system_role_dialog_intents SET cancel_requested=true WHERE id=$1 AND owner_email=$2', [turn.id, dialog.owner_email]);
        return this.request(req, dialog.id, turn.id);
    }
    private async owned(req: Request, dialogId: string, minimum = 1): Promise<SystemDialogRow> {
        await this.models.ready(); const actor = await this.models.actor(req), dialog = await this.repository.dialog(roleRequestId(dialogId), actor.email);
        await this.roles.policy.actor(req, dialog.project_id, minimum); return dialog;
    }
    private async assertOrigin(req: Request, dialog: SystemDialogRow): Promise<void> {
        await this.roles.repository.transaction(async db => {
            const actor = await this.roles.policy.actor(req, dialog.project_id);
            await this.roles.policy.authorize(db, actor, dialog.project_id);
            await assertChatSystemRoleOrigin(db, dialog.id, actor.email, dialog.project_id);
        });
    }
    private scope(dialog: SystemDialogRow, project: string | null): void {
        if (dialog.project_id !== project) throw new ConflictException('Сообщение относится к другому проекту.');
    }
    private requirePinned(dialog: SystemDialogRow): void {
        if (!dialog.agent_id) throw new ConflictException('Начните новый чат выбранной роли. Прежняя история и проверка отправки сохранены.');
    }
    private assertRole(dialog: SystemDialogRow, agentId: string): void {
        if (dialog.agent_id && dialog.agent_id !== agentId) throw new ConflictException('Этот чат закреплён за другой системной ролью.');
    }
    private dialogView(row: SystemDialogRow, agent?: SystemDialog['agentId']): SystemDialog {
        return { id: row.id, projectId: row.project_id, title: row.title, agentId: row.agent_id ?? agent ?? null, legacy: !row.agent_id, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
    }
    private async turnView(req: Request, row: SystemTurnRow): Promise<SystemTurn> {
        return { id: row.id, agentId: row.agent_id, instruction: row.input.instruction, createdAt: new Date(row.created_at).toISOString(), cancelRequested: row.cancel_requested,
            run: await this.roles.detail(req, row.agent_id, row.run_id) };
    }
}
