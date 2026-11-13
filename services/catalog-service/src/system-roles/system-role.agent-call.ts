import { randomUUID } from 'node:crypto';
import { HttpException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { securityEvent } from '../access/security-events';
import type { IChatAgentSnapshot } from '../model-chat/chat-group.interfaces';
import { ProjectChatService } from '../project-chat/project-chat.service';
import {
    PROJECT_CHAT_SYSTEM_CALL_ACTION,
    type IProjectChatSystemCallInput,
    type IProjectChatSystemCallOutcome,
    type IProjectChatSystemCallPort,
} from '../project-chat/project-chat-system-call';
import { projectChatRoomId } from '../project-chat/project-chat.utils';
import { ModelsService } from '../models/models.service';
import { roleDefinitionPin, systemRole } from './system-role.definitions';
import { SystemRoleRepository } from './system-role.repository';
import type { IRoleDefinition, IRoleRunRow } from './system-role.interfaces';
import { SystemRoleService } from './system-role.service';

const TERMINAL_RUN_STATES: readonly string[] = ['succeeded', 'awaiting_review', 'failed', 'interrupted', 'cancelled'];

/**
 * FR-310: executes an explicit project-agent call of a system role (a problem,
 * a clarification or a recovery when there is no path forward). `invoke` is
 * called from the project-chat finalization: it runs the durable system-role
 * pipeline (roleCallBudget fail-closed) and either schedules the terminal
 * outcome for delivery or records an actionable rejection. `deliver` stores
 * the outcome in the caller's room (a project-chat message carrying the
 * synthetic system-role snapshot) and completes the durable call row exactly
 * once (invoked -> delivered|failed); `reap` is the durable fallback (service
 * restart / hook failure) driven by the existing five-second sweep. Every
 * failure path yields an actionable next step (NFR-3).
 */
@Injectable()
export class SystemRoleAgentCall implements IProjectChatSystemCallPort {
    private readonly repository: SystemRoleRepository;

    constructor(
        private readonly models: ModelsService,
        private readonly systemRoles: SystemRoleService,
        private readonly chats: ProjectChatService,
    ) {
        this.repository = new SystemRoleRepository(models.pool);
        this.systemRoles.attachAgentCall(this);
        this.chats.attachSystemCalls(this);
    }

    async invoke(input: IProjectChatSystemCallInput): Promise<IProjectChatSystemCallOutcome> {
        const { req, projectId, call, snapshot } = input;
        const requestId = randomUUID();
        let definition: IRoleDefinition | undefined;
        let error: string | undefined;
        let snapshotRow: IChatAgentSnapshot = snapshot;
        try {
            definition = systemRole(call.roleId);
            snapshotRow = this.roleSnapshot(definition, snapshot);
        } catch (e) {
            error = this.actionable(e);
        }
        if (!definition || error) return { error, snapshot: snapshotRow };
        try {
            // No explicit targets: reading the room here would deadlock on the room-row lock
            // held by the project-chat finalization transaction this invoke runs inside. The
            // role receives the agent's question and the project knowledge index instead.
            const selection = {
                projectId,
                instruction: call.question,
                diagnostics: [] as string[],
                targets: [],
            };
            const prepared = await this.systemRoles.prepare(req, definition.id, selection);
            const view = await this.systemRoles.start(req, definition.id, {
                ...selection,
                requestId,
                modelId: snapshot.modelId,
                expectedModelPin: snapshot.modelPin,
                expectedDefinitionPin: prepared.definitionPin,
                consentDigest: prepared.consentDigest,
            });
            return { runId: view.id, requestId, snapshot: snapshotRow };
        } catch (e) {
            return { error: this.actionable(e), snapshot: snapshotRow };
        }
    }

    /** Terminal-run delivery: stores the outcome in the caller's room and completes the call row exactly once. */
    async deliver(runId: string): Promise<void> {
        const client = await this.models.pool.connect();
        try {
            await client.query('BEGIN');
            const call = (
                await client.query(
                    "SELECT * FROM project_chat_system_calls WHERE run_id=$1 AND state='invoked' FOR UPDATE",
                    [runId],
                )
            ).rows[0] as Record<string, unknown> | undefined;
            if (!call) {
                await client.query('COMMIT');
                return;
            }
            const run = await this.repository.get(runId, client, true);
            if (!run || !TERMINAL_RUN_STATES.includes(run.state)) {
                await client.query('COMMIT');
                return;
            }
            await this.deliverLocked(client, call, run);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            // Durable: the five-second reaper retries until the row completes.
            console.error('[system-role] call delivery failed:', e);
        } finally {
            client.release();
        }
    }

    /** Reaper: every invoked call whose run may have reached a terminal state. */
    async reap(): Promise<void> {
        const client = await this.models.pool.connect();
        try {
            const rows = (
                await client.query('SELECT run_id FROM project_chat_system_calls WHERE state=$1', ['invoked'])
            ).rows as Array<{ run_id: string }>;
            for (const row of rows) if (row.run_id) await this.deliver(row.run_id);
        } finally {
            client.release();
        }
    }

    private async deliverLocked(client: PoolClient, call: Record<string, unknown>, run: IRoleRunRow): Promise<void> {
        const runState = run.state;
        const delivered = runState === 'succeeded' || runState === 'awaiting_review';
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            'project-chat:' + String(call.project_id),
        ]);
        const room = await this.chats.repository.room(client, String(call.project_id), true, String(call.room_id));
        await client.query(
            `INSERT INTO project_chat_messages(id,project_id,room_id,kind,reply_to_id,source_message_id,status,snapshot,content,generation)
        VALUES($1,$2,$3,'agent',$4,$5,'done',$6::jsonb,$7,$8)`,
            [
                randomUUID(),
                String(call.project_id),
                projectChatRoomId(room),
                String(call.response_id),
                String(call.response_id),
                JSON.stringify(call.snapshot),
                this.renderOutcome(run, call),
                String(call.response_generation),
            ],
        );
        await client.query(
            'UPDATE project_chat_system_calls SET state=$1,run_state=$2,delivered_at=now() WHERE project_id=$3 AND room_id=$4 AND call_id=$5',
            [
                delivered ? 'delivered' : 'failed',
                runState,
                String(call.project_id),
                String(call.room_id),
                String(call.call_id),
            ],
        );
        await securityEvent(client, {
            actor: String(call.actor_email),
            action: PROJECT_CHAT_SYSTEM_CALL_ACTION,
            resourceId: String(call.call_id),
            before: { state: 'invoked' },
            after: { state: delivered ? 'delivered' : 'failed', runState },
        });
        await this.chats.repository.bump(client, room);
    }

    /** The synthetic role snapshot the call row and the delivery message carry (a per-role slot space, no UNIQUE collision). */
    private roleSnapshot(definition: IRoleDefinition, caller: IChatAgentSnapshot): IChatAgentSnapshot {
        const manifest = roleDefinitionPin(definition.id);
        return {
            agentId: definition.id,
            name: definition.name,
            slug: definition.id,
            version: 1,
            manifest,
            definition: {
                description: definition.description,
                prompt: 'Системная роль Нейроцентра.',
                mode: 'all',
                permission: {},
            },
            modelId: caller.modelId,
            modelName: caller.modelName,
            modelPin: caller.modelPin,
            sha256: manifest,
        };
    }

    private renderOutcome(run: IRoleRunRow, call: Record<string, unknown>): string {
        const role = systemRole(String(call.role_id));
        const name = role ? role.name : String(call.role_id);
        if (run.state === 'succeeded' || run.state === 'awaiting_review') {
            const result = run.result as { summary?: string; answer?: string; nextSteps?: string[] } | null;
            const lines = ['## Ответ системной роли «' + name + '»', ''];
            if (result) {
                if (result.summary) lines.push(result.summary, '');
                if (result.answer) lines.push(result.answer, '');
                if (result.nextSteps?.length) lines.push('Дальше:', ...result.nextSteps.map((step) => '- ' + step), '');
            }
            if (run.state === 'awaiting_review')
                lines.push('Результат требует подтверждения человека (запуск ' + run.id + ').', '');
            return lines.join('\n').trimEnd();
        }
        return (
            '## Вызов системной роли «' + name + '» не завершён\n\n' + (run.message || 'Состояние: ' + run.state) + '\n'
        );
    }

    private actionable(error: unknown): string {
        if (error instanceof HttpException) {
            const body = error.getResponse();
            if (typeof body === 'string') return body;
            const message = (body as Record<string, unknown>)?.message;
            if (typeof message === 'string' && message.trim()) return message;
            if (Array.isArray(message)) {
                const joined = message.filter((item): item is string => typeof item === 'string').join('; ');
                if (joined.trim()) return joined;
            }
        }
        return 'Не удалось выполнить системный вызов. Устраните причину и повторите запрос системной роли.';
    }
}
