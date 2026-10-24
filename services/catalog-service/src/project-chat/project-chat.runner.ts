import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { ProjectChatRepository } from './project-chat.repository';
import { ProjectChatDispatch } from './project-chat-dispatch';
import {DEFAULT_PROJECT_CHAT_ROOM} from './project-chat.types';
import type { ProjectChatInference, ProjectChatJob, ProjectChatMessageRow, ProjectChatStatus, ProjectChatTransport } from './project-chat.types';

const safeFailure = (error: unknown): string => error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException || error instanceof ServiceUnavailableException
    ? error.message : 'Агент не ответил. Проверьте подключение модели и повторите ответ.';
const markdownMetadata = (value: string): string => value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]()#+\-.!>|~]/g, '\\$&');
/** A result links each specialist contribution to its question without another hidden model call. */
export function projectChatSummary(source: ProjectChatMessageRow, responses: ProjectChatMessageRow[]): string {
    return `## Итог по вопросу\n\n[Сообщение пользователя](#project-chat-message-${source.id})\n\n` + responses.filter(row => row.kind === 'agent').map(row => {
        const role = row.snapshot?.definition.description || 'Специалист проекта', content = row.content.length > 4000 ? row.content.slice(0, 4000) + '\n\nПолный ответ — в сообщении выше.' : row.content;
        return `### ${markdownMetadata(row.snapshot?.name || 'Агент')} (@${markdownMetadata(row.snapshot?.slug || 'agent')})\n\nОбласть: ${markdownMetadata(role.slice(0, 1000))}\n\n${row.status === 'done' ? content : row.error || 'Ответ не получен.'}\n\n[Полный ответ агента](#project-chat-message-${row.id})`;
    }).join('\n\n');
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
    constructor(readonly repository: ProjectChatRepository, private readonly inference: ProjectChatInference) {}
    async start(): Promise<void> {
        for (const room of await this.repository.recover()) this.schedule(room.projectId, room.roomId);
        this.interval = setInterval(() => { void this.repository.recover().then(rooms => { for (const room of rooms) this.schedule(room.projectId, room.roomId); }).catch(() => undefined); }, 30000);
        this.interval.unref();
    }
    schedule(projectId: string, roomId?: string): void {
        if (this.stopped) return;
        if (roomId === undefined) { this.discover(projectId); return; }
        const key = JSON.stringify([projectId, roomId]);
        if (this.pending.has(key)) { this.reschedule.add(key); return; }
        const running = Promise.resolve().then(() => this.drain(projectId, roomId)).catch(() => undefined).finally(() => {
            if (this.pending.get(key) === running) this.pending.delete(key);
            if (this.reschedule.delete(key)) this.schedule(projectId, roomId);
        });
        this.pending.set(key, running);
    }
    private discover(projectId: string): void {
        if (this.discovering.has(projectId)) { this.rediscover.add(projectId); return; }
        const task = this.repository.queuedRooms(projectId).then(rooms => {
            for (const room of rooms) this.schedule(room.projectId, room.roomId);
        }).catch(() => undefined).finally(() => {
            this.discovering.delete(projectId);
            if (this.rediscover.delete(projectId)) this.schedule(projectId);
        });
        this.discovering.set(projectId, task);
    }
    cancel(messageId: string): void { this.active.get(messageId)?.abort(); }
    async waitIdle(): Promise<void> { while (this.pending.size || this.discovering.size) await Promise.all([...this.pending.values(), ...this.discovering.values()]); }
    async stop(): Promise<void> { this.stopped = true; if (this.interval) clearInterval(this.interval); for (const abort of this.active.values()) abort.abort(); await this.waitIdle(); }
    private async drain(projectId: string, roomId: string): Promise<void> {
        for (;;) {
            if (this.stopped) return;
            const job = await this.repository.claim(projectId, roomId); if (!job) return;
            if (this.stopped) { await this.fail(job, 'cancelled', 'Обработка остановлена. Готовые ответы сохранены.'); return; }
            const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(14 * 60 * 1000)]);
            this.active.set(job.source.id, abort);
            try { await this.execute(job, signal); }
            catch (error) { await this.fail(job, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? 'Обработка остановлена. Готовые ответы сохранены.' : safeFailure(error)); }
            finally { this.active.delete(job.source.id); }
        }
    }
    private async execute(job: ProjectChatJob, signal: AbortSignal): Promise<void> {
        const roomId = job.source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM, req = this.repository.policy.request(job.actor), responses = await this.repository.children(this.repository.pool, job.projectId, job.source.id, roomId);
        const groups: Record<ProjectChatTransport, Array<{ response: ProjectChatMessageRow; failed?: { error: unknown } }>> = { server: [], 'device-codex': [] };
        for (const response of responses.filter(row => row.kind === 'agent' && row.status !== 'done')) {
            signal.throwIfAborted();
            try { groups[await this.inference.transport(req, job.projectId, response.snapshot!)].push({ response }); }
            catch (error) { if (error instanceof ForbiddenException) throw error; groups.server.push({ response, failed: { error } }); }
        }
        const abort = new AbortController(), executionSignal = AbortSignal.any([signal, abort.signal]);
        const settled = await Promise.allSettled((['server', 'device-codex'] as const).map(async transport => {
            try {
                for (const item of groups[transport]) await this.dispatch.run(job.projectId, transport, executionSignal,
                    () => this.respond(job, item.response, executionSignal, item.failed));
            } catch (error) { abort.abort(error); throw error; }
        }));
        const failure = settled.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        await this.repository.scoped(job.projectId, job.actor, 2, true, async (db, room) => {
            signal.throwIfAborted(); await this.repository.assertRunning(db, job.projectId, job.source.id, job.generation);
            const children = await this.repository.children(db, job.projectId, job.source.id, roomId), complete = children.filter(row => row.kind === 'agent').every(row => row.status === 'done');
            await db.query("UPDATE project_chat_messages SET status=$4,content=$5,error=NULL,lease_until=NULL WHERE project_id=$1 AND source_message_id=$2 AND kind='summary' AND generation=$3 AND status='running'", [job.projectId, job.source.id, job.generation, complete ? 'done' : 'failed', projectChatSummary(job.source, children)]);
            await db.query("UPDATE project_chat_messages SET status=$4,error=$5,lease_until=NULL WHERE project_id=$1 AND id=$2 AND generation=$3 AND status='running'", [job.projectId, job.source.id, job.generation, complete ? 'done' : 'failed', complete ? null : 'Не все агенты ответили. Готовые ответы сохранены; можно повторить недостающие.']);
            await this.repository.bump(db, room);
        }, false, roomId);
    }
    private async respond(job: ProjectChatJob, response: ProjectChatMessageRow, signal: AbortSignal, failed?: { error: unknown }): Promise<void> {
        const roomId = job.source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM, req = this.repository.policy.request(job.actor);
        signal.throwIfAborted();
        try {
            if (failed) throw failed.error;
            await requireFeaturesEnabled(['project_chat', 'group_chat', ...(roomId === DEFAULT_PROJECT_CHAT_ROOM ? [] : ['project_chat_dialogs' as const])]);
            await this.repository.scoped(job.projectId, job.actor, 2, false, async (db, room) => {
                await this.repository.assertRunning(db, job.projectId, job.source.id, job.generation);
                if (!room.agent_ids.includes(response.snapshot!.agentId)) throw new ConflictException('Агент исключён из состава чата. Уже полученные ответы сохранены.');
                await this.inference.assert(req, job.projectId, response.snapshot!, db);
            }, false, roomId);
            const answer = await this.inference.infer({ req, projectId: job.projectId, source: job.source, response, signal });
            signal.throwIfAborted();
            if (!answer.content.trim() || Buffer.byteLength(answer.content) > 8 * 1024 ** 2) throw new BadRequestException('Агент вернул пустой или слишком большой ответ.');
            await this.repository.scoped(job.projectId, job.actor, 2, true, async (db, room) => {
                signal.throwIfAborted(); await this.repository.assertRunning(db, job.projectId, job.source.id, job.generation);
                if (!room.agent_ids.includes(response.snapshot!.agentId)) throw new ConflictException('Агент исключён из состава чата. Уже полученные ответы сохранены.');
                await this.inference.assert(req, job.projectId, response.snapshot!, db);
                const changed = await db.query("UPDATE project_chat_messages SET status='done',content=$4,usage=$5::jsonb,learning=$6::jsonb,error=NULL,lease_until=NULL WHERE project_id=$1 AND id=$2 AND generation=$3 AND status='running' AND lease_until>now()", [job.projectId, response.id, job.generation, answer.content, answer.usage ? JSON.stringify(answer.usage) : null, answer.learning ? JSON.stringify(answer.learning) : null]);
                if (!changed.rowCount) throw new ConflictException('Ответ уже остановлен или завершён.');
                await this.inference.assert(req, job.projectId, response.snapshot!, db); await this.repository.bump(db, room);
            }, false, roomId);
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof ForbiddenException) throw error;
            await this.repository.scoped(job.projectId, job.actor, 2, true, async (db, room) => {
                await this.repository.assertRunning(db, job.projectId, job.source.id, job.generation);
                await db.query("UPDATE project_chat_messages SET status='failed',error=$4,lease_until=NULL WHERE project_id=$1 AND id=$2 AND generation=$3 AND status='running'", [job.projectId, response.id, job.generation, safeFailure(error)]);
                await this.repository.bump(db, room);
            }, false, roomId);
        }
    }
    /** Cleanup is allowed after revocation but can publish only a safe terminal status, never model output. */
    private async fail(job: ProjectChatJob, status: ProjectChatStatus, error: string): Promise<void> {
        await this.repository.transaction(async db => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['project-chat:' + job.projectId]);
            const room = await this.repository.room(db, job.projectId, true, job.source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM); if (!room.revision) return;
            const changed = await db.query("UPDATE project_chat_messages SET status=$4,error=$5,lease_until=NULL WHERE project_id=$1 AND (id=$2 OR source_message_id=$2) AND generation=$3 AND status='running'", [job.projectId, job.source.id, job.generation, status, error]);
            if (changed.rowCount) await this.repository.bump(db, room);
        });
    }
}
