import type { Request } from 'express';
import type { IChatAgentSnapshot } from '../model-chat/chat-group.interfaces';

/**
 * FR-310: an agent explicitly invokes a system role (a problem, a clarification or a
 * recovery when there is no path forward). The directive travels inside a published
 * answer as a fenced JSON block and is executed by the runner in the finalization
 * transaction, so the durable call row and the audit record are stored together (NFR-4).
 * The role call itself runs through the durable system-role pipeline (roleCallBudget
 * fail-closed); the terminal outcome is delivered back to the caller's room, and every
 * failure path yields an actionable next step (NFR-3). Malformed or extra blocks never
 * fail the published answer.
 */
export const PROJECT_CHAT_SYSTEM_CALL_ACTION = 'project.chat.agent.system-call';
export const PROJECT_CHAT_SYSTEM_CALL_BLOCK = 'neurocenter-system-call';
export type TProjectChatSystemCallReason = 'problem' | 'clarification' | 'recovery';
const REASONS: readonly TProjectChatSystemCallReason[] = ['problem', 'clarification', 'recovery'];

export interface IProjectChatSystemCall {
    roleId: string;
    reason: TProjectChatSystemCallReason;
    question: string;
}

/** The runner port: the finalization stores the durable row; the implementation executes the role. */
export interface IProjectChatSystemCallInput {
    req: Request;
    projectId: string;
    roomId: string;
    roomVisibility: 'PUBLIC' | 'PRIVATE';
    call: IProjectChatSystemCall;
    snapshot: IChatAgentSnapshot;
}
/** `snapshot` is always present: the rejected row stores the synthetic role snapshot too. */
export interface IProjectChatSystemCallOutcome {
    runId?: string;
    requestId?: string;
    error?: string;
    snapshot: IChatAgentSnapshot;
}
export interface IProjectChatSystemCallPort {
    invoke(input: IProjectChatSystemCallInput): Promise<IProjectChatSystemCallOutcome>;
}

/** First valid directive wins; malformed blocks never fail the published answer. */
export function parseProjectChatSystemCall(content: string): IProjectChatSystemCall | null {
    const blocks = [
        ...content.matchAll(new RegExp('```' + PROJECT_CHAT_SYSTEM_CALL_BLOCK + '\\r?\\n([\\s\\S]*?)```', 'g')),
    ];
    for (const block of blocks) {
        let value: unknown;
        try {
            value = JSON.parse(block[1].trim());
        } catch {
            continue;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const candidate = value as Record<string, unknown>;
        if (Object.keys(candidate).sort().join(',') !== 'question,reason,roleId') continue;
        if (
            typeof candidate.roleId !== 'string' ||
            candidate.roleId.length < 1 ||
            candidate.roleId.length > 200 ||
            /[\r\n\\]/.test(candidate.roleId)
        )
            continue;
        if (typeof candidate.reason !== 'string' || !REASONS.includes(candidate.reason as TProjectChatSystemCallReason))
            continue;
        if (
            typeof candidate.question !== 'string' ||
            !candidate.question.trim() ||
            Buffer.byteLength(candidate.question) > 2048 ||
            candidate.question.includes('\0')
        )
            continue;
        return {
            roleId: candidate.roleId,
            reason: candidate.reason as TProjectChatSystemCallReason,
            question: candidate.question,
        };
    }
    return null;
}
