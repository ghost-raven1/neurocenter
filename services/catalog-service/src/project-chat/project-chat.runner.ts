import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import type { Request } from 'express';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { securityEvent } from '../access/security-events';
import { ProjectChatRepository } from './project-chat.repository';
import { ProjectChatDispatch } from './project-chat-dispatch';
import { DEFAULT_PROJECT_CHAT_ROOM } from './project-chat.constants';
import { projectChatRoomId } from './project-chat.utils';
import type { IChatAgentSnapshot } from '../model-chat/chat-group.interfaces';
import {
    PROJECT_CHAT_HANDOVER_ACTION,
    parseProjectChatHandover,
    type IProjectChatHandover,
} from './project-chat-handover';
import { PROJECT_CHAT_SHARE_ACTION, parseProjectChatShares, type IProjectChatShare } from './project-chat-share';
import {
    PROJECT_CHAT_SYSTEM_CALL_ACTION,
    parseProjectChatSystemCall,
    type IProjectChatSystemCall,
    type IProjectChatSystemCallPort,
} from './project-chat-system-call';
import type {
    TProjectChatDb,
    IProjectChatInference,
    IProjectChatJob,
    IProjectChatMessageRow,
    IProjectChatRoomRow,
    TProjectChatStatus,
    TProjectChatTransport,
} from './project-chat.interfaces';

const safeFailure = (error: unknown): string =>
    error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof ForbiddenException ||
    error instanceof ServiceUnavailableException
        ? error.message
        : 'Агент не ответил. Проверьте подключение модели и повторите ответ.';
const markdownMetadata = (value: string): string =>
    value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]()#+\-.!>|~]/g, '\\$&');
/** A result links each specialist contribution to its question without another hidden model call. */
export function projectChatSummary(source: IProjectChatMessageRow, responses: IProjectChatMessageRow[]): string {
    const answered = [
        ...new Map(
            responses
                .filter((row) => row.kind === 'agent' && row.status === 'done' && row.snapshot?.agentId)
                .map((row) => [row.snapshot!.agentId, row]),
        ).values(),
    ];
    if (answered.length < 2) return '';
    return (
        `## Итог по вопросу\n\n[Сообщение пользователя](#project-chat-message-${source.id})\n\n` +
        answered
            .map((row) => {
                const role = row.snapshot?.definition.description || 'Специалист проекта',
                    content =
                        row.content.length > 4000
                            ? row.content.slice(0, 4000) + '\n\nПолный ответ — в сообщении выше.'
                            : row.content;
                return `### ${markdownMetadata(row.snapshot?.name || 'Агент')} (@${markdownMetadata(row.snapshot?.slug || 'agent')})\n\nОбласть: ${markdownMetadata(role.slice(0, 1000))}\n\n${content}\n\n[Полный ответ агента](#project-chat-message-${row.id})`;
            })
            .join('\n\n')
    );
}
/** Durable FIFO admits separate user questions; failed attempts never start a paid retry automatically. */
export class ProjectChatRunner {
    private readonly pending = new Map<string, Promise<void>>();
    private readonly reschedule = new Set<string>();
    private readonly active = new Map<string, AbortController>();
    private readonly discovering = new Map<string, Promise<void>>();
    private readonly rediscover = new Set<string>();
    private readonly dispatch = new ProjectChatDispatch();
    private stopped = false;
    private interval?: ReturnType<typeof setInterval>;
    private systemCalls?: IProjectChatSystemCallPort;
    constructor(
        readonly repository: ProjectChatRepository,
        private readonly inference: IProjectChatInference,
    ) {}
    /** FR-310: the system-role call port is attached late (the implementation is wired in the module graph). */
    attachSystemCalls(impl: IProjectChatSystemCallPort): void {
        this.systemCalls = impl;
    }
    async start(): Promise<void> {
        for (const room of await this.repository.recover()) this.schedule(room.projectId, room.roomId);
        this.interval = setInterval(() => {
            void this.repository
                .recover()
                .then((rooms) => {
                    for (const room of rooms) this.schedule(room.projectId, room.roomId);
                })
                .catch(() => undefined);
        }, 30000);
        this.interval.unref();
    }
    schedule(projectId: string, roomId?: string): void {
        if (this.stopped) return;
        if (roomId === undefined) {
            this.discover(projectId);
            return;
        }
        const key = JSON.stringify([projectId, roomId]);
        if (this.pending.has(key)) {
            this.reschedule.add(key);
            return;
        }
        const running = Promise.resolve()
            .then(() => this.drain(projectId, roomId))
            .catch(() => undefined)
            .finally(() => {
                if (this.pending.get(key) === running) this.pending.delete(key);
                if (this.reschedule.delete(key)) this.schedule(projectId, roomId);
            });
        this.pending.set(key, running);
    }
    private discover(projectId: string): void {
        if (this.discovering.has(projectId)) {
            this.rediscover.add(projectId);
            return;
        }
        const task = this.repository
            .queuedRooms(projectId)
            .then((rooms) => {
                for (const room of rooms) this.schedule(room.projectId, room.roomId);
            })
            .catch(() => undefined)
            .finally(() => {
                this.discovering.delete(projectId);
                if (this.rediscover.delete(projectId)) this.schedule(projectId);
            });
        this.discovering.set(projectId, task);
    }
    cancel(messageId: string): void {
        this.active.get(messageId)?.abort();
    }
    async waitIdle(): Promise<void> {
        while (this.pending.size || this.discovering.size)
            await Promise.all([...this.pending.values(), ...this.discovering.values()]);
    }
    async stop(): Promise<void> {
        this.stopped = true;
        if (this.interval) clearInterval(this.interval);
        for (const abort of this.active.values()) abort.abort();
        await this.waitIdle();
    }
    private async drain(projectId: string, roomId: string): Promise<void> {
        for (;;) {
            if (this.stopped) return;
            const job = await this.repository.claim(projectId, roomId);
            if (!job) return;
            if (this.stopped) {
                await this.fail(job, 'cancelled', 'Обработка остановлена. Готовые ответы сохранены.');
                return;
            }
            const abort = new AbortController(),
                signal = AbortSignal.any([abort.signal, AbortSignal.timeout(14 * 60 * 1000)]);
            this.active.set(job.source.id, abort);
            try {
                await this.execute(job, signal);
            } catch (error) {
                await this.fail(
                    job,
                    signal.aborted ? 'cancelled' : 'failed',
                    signal.aborted ? 'Обработка остановлена. Готовые ответы сохранены.' : safeFailure(error),
                );
            } finally {
                this.active.delete(job.source.id);
            }
        }
    }
    private async execute(job: IProjectChatJob, signal: AbortSignal): Promise<void> {
        const roomId = job.source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM,
            req = this.repository.policy.request(job.actor),
            responses = await this.repository.children(this.repository.pool, job.projectId, job.source.id, roomId);
        const groups: Record<
            TProjectChatTransport,
            Array<{ response: IProjectChatMessageRow; failed?: { error: unknown } }>
        > = { server: [], 'device-codex': [] };
        for (const response of responses.filter((row) => row.kind === 'agent' && row.status !== 'done')) {
            signal.throwIfAborted();
            try {
                groups[await this.inference.transport(req, job.projectId, response.snapshot!)].push({ response });
            } catch (error) {
                if (error instanceof ForbiddenException) throw error;
                groups.server.push({ response, failed: { error } });
            }
        }
        const abort = new AbortController(),
            executionSignal = AbortSignal.any([signal, abort.signal]);
        const settled = await Promise.allSettled(
            (['server', 'device-codex'] as const).map(async (transport) => {
                try {
                    for (const item of groups[transport])
                        await this.dispatch.run(job.projectId, transport, executionSignal, () =>
                            this.respond(job, item.response, executionSignal, item.failed),
                        );
                } catch (error) {
                    abort.abort(error);
                    throw error;
                }
            }),
        );
        const failure = settled.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        await this.repository.scoped(
            job.projectId,
            job.actor,
            2,
            true,
            async (db, room) => {
                signal.throwIfAborted();
                await this.repository.assertRunning(db, job.projectId, job.source.id, job.generation);
                const children = await this.repository.children(db, job.projectId, job.source.id, roomId),
                    complete = children.filter((row) => row.kind === 'agent').every((row) => row.status === 'done');
                // FR-309: shared context elements are durable before any handover re-queue,
                // so the connected agent sees them in its context.
                await this.finalizeShares(db, room, job, children);
                // FR-310: an agent may explicitly invoke a system role; the durable call row and
                // the audit are stored in this finalization transaction (NFR-4).
                await this.finalizeSystemCalls(db, room, job, req, children);
                // FR-302: a handover re-queues the task under a fresh generation; the connected agent
                // completes it and the final summary is built then, with its answer included.
                if (await this.finalizeHandovers(db, room, job, req, children)) {
                    await this.repository.bump(db, room);
                    return;
                }
                const summary = projectChatSummary(job.source, children);
                if (summary)
                    await db.query(
                        `INSERT INTO project_chat_messages(id,project_id,room_id,kind,reply_to_id,source_message_id,status,content,generation)
                VALUES($1,$2,$3,'summary',$4,$4,$5,$6,$7)
                ON CONFLICT(source_message_id) WHERE kind='summary' DO UPDATE SET status=EXCLUDED.status,content=EXCLUDED.content,error=NULL,lease_until=NULL
                WHERE project_chat_messages.generation=EXCLUDED.generation AND project_chat_messages.status='running'`,
                        [
                            randomUUID(),
                            job.projectId,
                            roomId,
                            job.source.id,
                            complete ? 'done' : 'failed',
                            summary,
                            job.generation,
                        ],
                    );
                // Only an unfilled legacy placeholder can disappear; received historical content remains intact.
                else {
                    await db.query(
                        "DELETE FROM project_chat_messages WHERE project_id=$1 AND source_message_id=$2 AND kind='summary' AND generation=$3 AND status='running' AND content=''",
                        [job.projectId, job.source.id, job.generation],
                    );
                    await db.query(
                        "UPDATE project_chat_messages SET status=$4,error=NULL,lease_until=NULL WHERE project_id=$1 AND source_message_id=$2 AND kind='summary' AND generation=$3 AND status='running'",
                        [job.projectId, job.source.id, job.generation, complete ? 'done' : 'failed'],
                    );
                }
                await db.query(
                    "UPDATE project_chat_messages SET status=$4,error=$5,lease_until=NULL WHERE project_id=$1 AND id=$2 AND generation=$3 AND status='running'",
                    [
                        job.projectId,
                        job.source.id,
                        job.generation,
                        complete ? 'done' : 'failed',
                        complete
                            ? null
                            : 'Не все агенты ответили. Готовые ответы сохранены; можно повторить недостающие.',
                    ],
                );
                await this.repository.bump(db, room);
            },
            false,
            roomId,
        );
    }
    private async respond(
        job: IProjectChatJob,
        response: IProjectChatMessageRow,
        signal: AbortSignal,
        failed?: { error: unknown },
    ): Promise<void> {
        const roomId = job.source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM,
            req = this.repository.policy.request(job.actor);
        signal.throwIfAborted();
        try {
            if (failed) throw failed.error;
            await requireFeaturesEnabled([
                'project_chat',
                'group_chat',
                ...(roomId === DEFAULT_PROJECT_CHAT_ROOM ? [] : ['project_chat_dialogs' as const]),
            ]);
            await this.repository.scoped(
                job.projectId,
                job.actor,
                2,
                false,
                async (db, room) => {
                    await this.repository.assertRunning(db, job.projectId, job.source.id, job.generation);
                    if (!room.agent_ids.includes(response.snapshot!.agentId))
                        throw new ConflictException('Агент исключён из состава чата. Уже полученные ответы сохранены.');
                    await this.inference.assert(req, job.projectId, response.snapshot!, db);
                },
                false,
                roomId,
            );
            const answer = await this.inference.infer({
                req,
                projectId: job.projectId,
                source: job.source,
                response,
                signal,
            });
            signal.throwIfAborted();
            if (!answer.content.trim() || Buffer.byteLength(answer.content) > 8 * 1024 ** 2)
                throw new BadRequestException('Агент вернул пустой или слишком большой ответ.');
            await this.repository.scoped(
                job.projectId,
                job.actor,
                2,
                true,
                async (db, room) => {
                    signal.throwIfAborted();
                    await this.repository.assertRunning(db, job.projectId, job.source.id, job.generation);
                    if (!room.agent_ids.includes(response.snapshot!.agentId))
                        throw new ConflictException('Агент исключён из состава чата. Уже полученные ответы сохранены.');
                    await this.inference.assert(req, job.projectId, response.snapshot!, db);
                    await answer.assertCurrent?.(db);
                    const changed = await db.query(
                        "UPDATE project_chat_messages SET status='done',content=$4,usage=$5::jsonb,learning=$6::jsonb,error=NULL,lease_until=NULL WHERE project_id=$1 AND id=$2 AND generation=$3 AND status='running' AND lease_until>now()",
                        [
                            job.projectId,
                            response.id,
                            job.generation,
                            answer.content,
                            answer.usage ? JSON.stringify(answer.usage) : null,
                            answer.learning ? JSON.stringify(answer.learning) : null,
                        ],
                    );
                    if (!changed.rowCount) throw new ConflictException('Ответ уже остановлен или завершён.');
                    await this.inference.assert(req, job.projectId, response.snapshot!, db);
                    await answer.assertCurrent?.(db);
                    await this.repository.bump(db, room);
                },
                false,
                roomId,
            );
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof ForbiddenException) throw error;
            await this.repository.scoped(
                job.projectId,
                job.actor,
                2,
                true,
                async (db, room) => {
                    await this.repository.assertRunning(db, job.projectId, job.source.id, job.generation);
                    await db.query(
                        "UPDATE project_chat_messages SET status='failed',error=$4,lease_until=NULL WHERE project_id=$1 AND id=$2 AND generation=$3 AND status='running'",
                        [job.projectId, response.id, job.generation, safeFailure(error)],
                    );
                    await this.repository.bump(db, room);
                },
                false,
                roomId,
            );
        }
    }
    /**
     * FR-309: a published answer may share context elements (state/result/decision) with other
     * agents, a user (private dialogue) or the team (public room). Each element is stored with
     * per-item provenance (sharing agent, referenced source, version, SHA, time; NFR-4) and
     * audited in the same finalization transaction. Sharing is gated on the agent's access to
     * the target room (fail-closed); a private source never leaks into a public room (FR-403).
     * The handover (FR-302) is the audited special case. Ungated or invalid directives never
     * fail the published answers.
     */
    private async finalizeShares(
        db: TProjectChatDb,
        room: IProjectChatRoomRow,
        job: IProjectChatJob,
        children: IProjectChatMessageRow[],
    ): Promise<void> {
        for (const child of children) {
            if (child.kind !== 'agent' || child.status !== 'done' || !child.snapshot) continue;
            if (!room.agent_ids.includes(child.snapshot.agentId)) continue;
            for (const share of parseProjectChatShares(child.content))
                await this.finalizeShare(db, room, job, child, share);
        }
    }
    /**
     * FR-310: a published agent answer may explicitly invoke a system role (a problem,
     * a clarification or a recovery). The durable call row and the audit are stored in
     * this finalization transaction (NFR-4); the role call runs through the durable
     * system-role pipeline and its terminal outcome is delivered back to this room.
     * A rejected call posts the actionable error row immediately; malformed directives
     * never fail the published answers.
     */
    private async finalizeSystemCalls(
        db: TProjectChatDb,
        room: IProjectChatRoomRow,
        job: IProjectChatJob,
        req: Request,
        children: IProjectChatMessageRow[],
    ): Promise<void> {
        if (!this.systemCalls) return;
        for (const child of children) {
            if (child.kind !== 'agent' || child.status !== 'done' || !child.snapshot) continue;
            if (!room.agent_ids.includes(child.snapshot.agentId)) continue;
            const call = parseProjectChatSystemCall(child.content);
            if (!call) continue;
            await this.finalizeSystemCall(db, room, job, req, child, call);
        }
    }
    private async finalizeSystemCall(
        db: TProjectChatDb,
        room: IProjectChatRoomRow,
        job: IProjectChatJob,
        req: Request,
        child: IProjectChatMessageRow,
        call: IProjectChatSystemCall,
    ): Promise<void> {
        const callId = randomUUID(),
            snapshot = child.snapshot!,
            outcome = await this.systemCalls!.invoke({
                req,
                projectId: job.projectId,
                roomId: room.id ?? DEFAULT_PROJECT_CHAT_ROOM,
                roomVisibility: room.visibility ?? 'PUBLIC',
                call,
                snapshot,
            }),
            state = outcome.error ? 'rejected' : 'invoked';
        await db.query(
            `INSERT INTO project_chat_system_calls(project_id,room_id,call_id,actor_email,actor_role,source_message_id,response_id,response_generation,agent_id,agent_name,snapshot,role_id,reason,question,run_id,request_id,state,error)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18)`,
            [
                job.projectId,
                projectChatRoomId(room),
                callId,
                job.actor.email,
                job.actor.activeRole,
                job.source.id,
                child.id,
                child.generation,
                snapshot.agentId,
                snapshot.name,
                JSON.stringify(outcome.snapshot),
                call.roleId,
                call.reason,
                call.question,
                outcome.runId ?? null,
                outcome.requestId ?? null,
                state,
                outcome.error ?? null,
            ],
        );
        if (outcome.error)
            await db.query(
                `INSERT INTO project_chat_messages(id,project_id,room_id,kind,reply_to_id,source_message_id,status,snapshot,content,generation)
            VALUES($1,$2,$3,'agent',$4,$5,'done',$6::jsonb,$7,$8)`,
                [
                    randomUUID(),
                    job.projectId,
                    projectChatRoomId(room),
                    child.id,
                    child.id,
                    JSON.stringify(outcome.snapshot),
                    '## Вызов системной роли не выполнен\n\n' + outcome.error,
                    child.generation,
                ],
            );
        await securityEvent(db, {
            actor: job.actor.email,
            action: PROJECT_CHAT_SYSTEM_CALL_ACTION,
            resourceId: callId,
            before: null,
            after: {
                callId,
                sourceMessageId: job.source.id,
                responseId: child.id,
                responseGeneration: child.generation,
                agentId: snapshot.agentId,
                agentName: snapshot.name,
                roleId: call.roleId,
                reason: call.reason,
                question: call.question,
                runId: outcome.runId ?? null,
                requestId: outcome.requestId ?? null,
                state,
                error: outcome.error ?? null,
            },
        });
    }
    private async finalizeShare(
        db: TProjectChatDb,
        room: IProjectChatRoomRow,
        job: IProjectChatJob,
        child: IProjectChatMessageRow,
        share: IProjectChatShare,
    ): Promise<void> {
        const agentId = child.snapshot!.agentId;
        const target = (
            await db.query<IProjectChatRoomRow>('SELECT * FROM project_chat_rooms WHERE project_id=$1 AND id=$2', [
                job.projectId,
                share.roomId,
            ])
        ).rows[0];
        if (!target || !target.agent_ids.includes(agentId)) {
            console.error('[project-chat] shared context skipped: no access to target room ' + share.roomId);
            return;
        }
        const currentRoomId = room.id ?? DEFAULT_PROJECT_CHAT_ROOM,
            stored: Array<{
                itemId: string;
                kind: string;
                refMessageId: string | null;
                sourceRoomId: string;
                sourceGeneration: string;
                contentSha: string;
            }> = [];
        for (const item of share.items) {
            // what-ref defaults to the carrying answer: the element quotes the response that carries it.
            let refMessageId: string | null = child.id,
                sourceRoomId = currentRoomId,
                sourceGeneration = child.generation;
            if (item.ref) {
                const ref = (
                    await db.query<{ id: string; room_id: string; kind: string; status: string; generation: string }>(
                        'SELECT id,room_id,kind,status,generation FROM project_chat_messages WHERE project_id=$1 AND id=$2',
                        [job.projectId, item.ref],
                    )
                ).rows[0];
                if (!ref || ref.status !== 'done' || !['user', 'agent', 'summary'].includes(ref.kind)) {
                    console.error('[project-chat] shared context skipped: unknown or unpublished source ' + item.ref);
                    continue;
                }
                const refRoom = (
                    await db.query<IProjectChatRoomRow>(
                        'SELECT * FROM project_chat_rooms WHERE project_id=$1 AND id=$2',
                        [job.projectId, ref.room_id],
                    )
                ).rows[0];
                if (!refRoom || !refRoom.agent_ids.includes(agentId)) {
                    console.error('[project-chat] shared context skipped: no access to the source room of ' + item.ref);
                    continue;
                }
                if (refRoom.visibility === 'PRIVATE' && target.visibility !== 'PRIVATE') {
                    console.error(
                        '[project-chat] shared context skipped: a private source must not enter a public room (FR-403)',
                    );
                    continue;
                }
                refMessageId = ref.id;
                sourceRoomId = ref.room_id;
                sourceGeneration = ref.generation;
            } else if (room.visibility === 'PRIVATE' && target.visibility !== 'PRIVATE') {
                console.error(
                    '[project-chat] shared context skipped: a private source must not enter a public room (FR-403)',
                );
                continue;
            }
            const itemId = randomUUID(),
                contentSha = createHash('sha256').update(item.content).digest('hex');
            await db.query(
                `INSERT INTO project_chat_shared_items(project_id,room_id,item_id,kind,content,ref_message_id,source_room_id,source_agent_id,source_agent_name,source_generation,content_sha)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [
                    job.projectId,
                    target.id ?? DEFAULT_PROJECT_CHAT_ROOM,
                    itemId,
                    item.kind,
                    item.content,
                    refMessageId,
                    sourceRoomId,
                    agentId,
                    child.snapshot!.name ?? null,
                    sourceGeneration,
                    contentSha,
                ],
            );
            stored.push({ itemId, kind: item.kind, refMessageId, sourceRoomId, sourceGeneration, contentSha });
        }
        if (!stored.length) return;
        await securityEvent(db, {
            actor: job.actor.email,
            action: PROJECT_CHAT_SHARE_ACTION,
            resourceId: child.id,
            before: null,
            after: {
                roomId: target.id ?? DEFAULT_PROJECT_CHAT_ROOM,
                roomVisibility: target.visibility,
                agentId,
                responseId: child.id,
                responseGeneration: child.generation,
                items: stored,
            },
        });
    }
    /**
     * FR-302: a published answer may direct a room colleague to join the task. The connection
     * runs in the finalization transaction with its audit (NFR-4); it re-queues the task under
     * a fresh generation, so the connected agent sees the published answers of the previous
     * executors (sequential context) before its call. Invalid, duplicate or self-directed
     * directives never fail the published answers.
     */
    private async finalizeHandovers(
        db: TProjectChatDb,
        room: IProjectChatRoomRow,
        job: IProjectChatJob,
        req: Request,
        children: IProjectChatMessageRow[],
    ): Promise<boolean> {
        const handovers: Array<{ from: IProjectChatMessageRow; to: IProjectChatHandover }> = [];
        for (const child of children) {
            if (child.kind !== 'agent' || child.status !== 'done' || !child.snapshot) continue;
            if (!room.agent_ids.includes(child.snapshot.agentId)) continue;
            const handover = parseProjectChatHandover(child.content);
            if (!handover || handover.agentId === child.snapshot.agentId) continue;
            if (!room.agent_ids.includes(handover.agentId)) continue;
            if (children.some((row) => row.kind === 'agent' && row.snapshot?.agentId === handover.agentId)) continue;
            handovers.push({ from: child, to: handover });
        }
        if (!handovers.length) return false;
        const generation = randomUUID(),
            connected: Array<{
                target: IChatAgentSnapshot;
                handover: IProjectChatHandover;
                from: IProjectChatMessageRow;
            }> = [];
        for (const { from, to } of handovers) {
            let target: IChatAgentSnapshot | undefined;
            try {
                [target] = await this.inference.resolve(req, job.projectId, room, [to.agentId], db);
            } catch (error) {
                // The agent is no longer available; the published answer stands, the connection is skipped.
                console.error(
                    '[project-chat] handover connection skipped: ' +
                        String(error instanceof Error ? error.message : error),
                );
                target = undefined;
            }
            if (target) connected.push({ target, handover: to, from });
        }
        if (!connected.length) return false;
        for (const { target, handover, from } of connected) {
            await db.query(
                `INSERT INTO project_chat_messages(id,project_id,room_id,kind,reply_to_id,source_message_id,status,snapshot,generation)
                VALUES($1,$2,$6,'agent',$3,$3,'queued',$4::jsonb,$5)`,
                [
                    randomUUID(),
                    job.projectId,
                    job.source.id,
                    JSON.stringify(target),
                    generation,
                    room.id ?? DEFAULT_PROJECT_CHAT_ROOM,
                ],
            );
            await securityEvent(db, {
                actor: job.actor.email,
                action: PROJECT_CHAT_HANDOVER_ACTION,
                resourceId: job.source.id,
                before: null,
                after: {
                    taskId: job.source.id,
                    fromAgentId: from.snapshot!.agentId,
                    fromAnswerId: from.id,
                    fromAnswerGeneration: from.generation,
                    toAgentId: handover.agentId,
                    note: handover.note,
                },
            });
        }
        const requeued = await db.query(
            "UPDATE project_chat_messages SET status='queued',generation=$3,lease_until=NULL,error=NULL WHERE project_id=$1 AND id=$2 AND kind='user' AND status='running' AND generation=$4",
            [job.projectId, job.source.id, generation, job.generation],
        );
        if (!requeued.rowCount)
            throw new ConflictException('Задание уже остановлено; подключение агента не выполнено.');
        return true;
    }
    /** Cleanup is allowed after revocation but can publish only a safe terminal status, never model output. */
    private async fail(job: IProjectChatJob, status: TProjectChatStatus, error: string): Promise<void> {
        await this.repository.transaction(async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['project-chat:' + job.projectId]);
            const room = await this.repository.room(
                db,
                job.projectId,
                true,
                job.source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM,
            );
            if (!room.revision) return;
            const changed = await db.query(
                "UPDATE project_chat_messages SET status=$4,error=$5,lease_until=NULL WHERE project_id=$1 AND (id=$2 OR source_message_id=$2) AND generation=$3 AND status='running'",
                [job.projectId, job.source.id, job.generation, status, error],
            );
            if (changed.rowCount) await this.repository.bump(db, room);
        });
    }
}
