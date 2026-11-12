import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { securityEvent } from '../access/security-events';
import { ProjectChatRepository } from './project-chat.repository';
import { ProjectChatDispatch } from './project-chat-dispatch';
import { DEFAULT_PROJECT_CHAT_ROOM } from './project-chat.constants';
import type { IChatAgentSnapshot } from '../model-chat/chat-group.interfaces';
import {
    PROJECT_CHAT_HANDOVER_ACTION,
    parseProjectChatHandover,
    type IProjectChatHandover,
} from './project-chat-handover';
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
    constructor(
        readonly repository: ProjectChatRepository,
        private readonly inference: IProjectChatInference,
    ) {}
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
