import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { assertMethodChatOrigin } from '../agent-method-workflows/chat-origin';
import { assertBackgroundAgentCompletionAccess } from './jobs';
import type { PgBackgroundAgentStore } from './pg-store';
import type { IRuntimeResult } from './runtime';
import type { IResultSink } from './worker';

/** The fixed identity of the server background agent in the project chat (a synthetic snapshot row). */
const BACKGROUND_AGENT = {
    agentId: 'background-agent',
    name: 'Фоновый агент',
    slug: 'background-agent',
} as const;

function renderReceipt(result: IRuntimeResult): string {
    const checks = result.checks
        .map((check) => {
            const outcome =
                check.state === 'not_run'
                    ? 'не выполнена'
                    : check.exitCode !== null
                      ? `exit ${check.exitCode}`
                      : check.signal
                        ? `сигнал ${check.signal}`
                        : check.state;
            return `- \`${check.command} ${check.args.join(' ')}\` — ${outcome}`;
        })
        .join('\n');
    const heading =
        result.state === 'succeeded'
            ? 'Фоновая задача завершена: все объявленные проверки пройдены.'
            : result.state === 'unknown'
              ? 'Результат фоновой задачи не подтверждён: исполнение началось, но завершение не зафиксировано. Запустите задачу заново.'
              : result.state === 'cancelled'
                ? 'Фоновая задача отменена.'
                : `Фоновая задача не выполнена на этапе «${result.stage}»: ${result.failure?.code ?? 'UNKNOWN'} (${result.failure?.action ?? 'review-result'}).`;
    return `### Фоновый агент\n\n${heading}\n\nПроверки:\n${checks}`;
}

/**
 * FR-305 (agt-07, phase B, I/O row 2): the chat-origin result sink. The verified receipt (entry 6)
 * becomes a done agent message in the room of the source message; the publication is one atomic
 * transaction (message + room revision bump). Revoked access (or a source message that is no longer
 * a user message) withholds the receipt — `publish_state='withheld'`, the recorded result is never
 * discarded and never re-published. A lost-ACK re-delivery re-inserts the same receipt only when the
 * first publication did not commit; a committed publication blocks the slot
 * (source_message_id, agentId) and the re-delivery settles as withheld instead of duplicating.
 */
export class BackgroundAgentChatSink implements IResultSink {
    constructor(
        private readonly pool: Pool,
        private readonly store: PgBackgroundAgentStore,
    ) {}

    async deliver(requestId: string, result: IRuntimeResult): Promise<void> {
        const job = await this.store.findRow(requestId);
        if (!job || !job.project_id || !job.source_message_id) {
            // No durable chat origin: the result stays recorded on the job row, publication is
            // withheld — never discarded.
            if (job) await this.store.markWithheld(job.request_key);
            return;
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            try {
                const source = (
                    await client.query<{ room_id: string }>(
                        'SELECT room_id FROM project_chat_messages WHERE project_id=$1 AND id=$2 FOR SHARE',
                        [job.project_id, job.source_message_id],
                    )
                ).rows[0];
                if (!source) throw new NotFoundException('Исходное сообщение не найдено.');
                // Current-state recheck as the job owner (recovery mode: a late completion may not
                // outlive the owner's account, grant or room access).
                await assertMethodChatOrigin(
                    client,
                    job.project_id,
                    { email: job.email, activeRole: job.role },
                    { roomId: source.room_id, messageId: job.source_message_id },
                    true,
                    true,
                );
                await assertBackgroundAgentCompletionAccess(client, job);
                try {
                    await client.query(
                        `INSERT INTO project_chat_messages(id,project_id,room_id,kind,reply_to_id,source_message_id,status,snapshot,content,generation)
                     VALUES($1,$2,$3,'agent',$4,$4,'done',$5::jsonb,$6,$7)`,
                        [
                            randomUUID(),
                            job.project_id,
                            source.room_id,
                            job.source_message_id,
                            JSON.stringify(this.snapshot()),
                            renderReceipt(result),
                            randomUUID(),
                        ],
                    );
                } catch (error) {
                    // The (source_message_id, agentId) slot is taken: an earlier publication from the
                    // same message already exists. Withhold, never replace and never discard.
                    if ((error as { code?: string })?.code === '23505')
                        throw new NotFoundException('Результат этой задачи уже опубликован в диалоге.');
                    throw error;
                }
                await client.query(
                    'UPDATE project_chat_rooms SET revision=revision+1, updated_at=now() WHERE project_id=$1 AND id=$2',
                    [job.project_id, source.room_id],
                );
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK').catch(() => undefined);
                if (error instanceof ForbiddenException || error instanceof NotFoundException) {
                    await this.store.markWithheld(job.request_key);
                    return;
                }
                throw error;
            }
        } finally {
            client.release();
        }
    }

    private snapshot(): Record<string, unknown> {
        return {
            ...BACKGROUND_AGENT,
            version: 1,
            manifest: 'background-agent',
            definition: {
                description: 'Фоновый агент проекта: выполнение задачи в opencode-среде сервера с проверками.',
                prompt: '',
                mode: 'primary',
                permission: {},
            },
            modelId: '',
            modelName: '',
            modelPin: '',
            sha256: '',
        };
    }
}
