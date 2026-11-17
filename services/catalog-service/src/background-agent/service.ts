import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { assertMethodChatOrigin } from '../agent-method-workflows/chat-origin';
import { ModelsService } from '../models/models.service';
import { ProjectChatPolicy } from '../project-chat/project-chat.policy';
import { projectChatUuid } from '../project-chat/project-chat.validation';
import { BACKGROUND_AGENT_OPENCODE_VERSION } from './engine';
import { backgroundAgentJobPayload, type IBackgroundAgentJobInput } from './jobs';
import type { PgBackgroundAgentStore } from './pg-store';

export interface IBackgroundAgentStartReceipt {
    requestKey: string;
    projectId: string;
    state: 'pending';
}

/**
 * FR-305 (agt-07, phase B): admission of a server background-agent run from a published chat
 * message. The authorization is the internal bridge policy (x-neurocenter-internal +
 * x-bridge-actor) plus the level-2 chat origin (room + source user message) — the
 * agent-method-workflows shape minus the device binding: the admitting user's project grant is the
 * execution authority. Everything else (request id, method version, deadline, runtime version) is
 * fixed by the server. Admission is a cheap synchronous commit; the run itself is asynchronous in
 * the background-agent executor and never blocks the chat (I/O row 1).
 */
@Injectable()
export class BackgroundAgentService {
    private readonly policy = new ProjectChatPolicy();
    constructor(
        private readonly models: ModelsService,
        private readonly store: PgBackgroundAgentStore,
    ) {}

    async start(
        req: Request,
        projectId: string,
        roomId: string,
        messageId: string,
        body: unknown,
    ): Promise<IBackgroundAgentStartReceipt> {
        const actor = this.policy.input(req);
        const origin = { roomId: projectChatUuid(roomId), messageId: projectChatUuid(messageId) };
        const requestKey = randomUUID();
        const raw = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<
            string,
            unknown
        >;
        const payload = backgroundAgentJobPayload({
            requestKey,
            projectId,
            method: raw.method as IBackgroundAgentJobInput['method'],
            instruction: raw.instruction as IBackgroundAgentJobInput['instruction'],
            checks: raw.checks as IBackgroundAgentJobInput['checks'],
            ...(typeof raw.context === 'object' && raw.context !== null && !Array.isArray(raw.context)
                ? { context: raw.context as IBackgroundAgentJobInput['context'] }
                : {}),
        });
        const client = await this.models.pool.connect();
        try {
            await client.query('BEGIN');
            await assertMethodChatOrigin(client, projectId, actor, origin, false, true);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
        try {
            await this.store.admitWithLink(payload, {
                email: actor.email,
                role: actor.activeRole,
                sourceMessageId: origin.messageId,
                runtimeVersion: BACKGROUND_AGENT_OPENCODE_VERSION,
            });
        } catch (error) {
            const code = (error as { code?: string })?.code;
            if (code === '23505' || code === '23503')
                throw new ConflictException('Исходное сообщение изменено или задача уже запущена.');
            throw error;
        }
        return { requestKey, projectId, state: 'pending' };
    }
}
