/**
 * FR-302: an agent connects another project agent to the task it is solving.
 * The directive travels inside a published answer as a fenced JSON block and is
 * executed by the runner in the same transaction that publishes the answer, so the
 * audit record and the connection are durable together (NFR-4).
 */
export const PROJECT_CHAT_HANDOVER_ACTION = 'project.chat.agent.handover';
export const PROJECT_CHAT_HANDOVER_BLOCK = 'neurocenter-handover';
/** The platform agent-id shape (agent-<stable id>); mirrors the chat-agent id contract. */
const AGENT_ID = /^agent-[a-z0-9][a-z0-9-]{0,120}$/i;

export interface IProjectChatHandover {
    agentId: string;
    note: string;
}

/** First valid directive wins; malformed blocks never fail the published answer. */
export function parseProjectChatHandover(content: string): IProjectChatHandover | null {
    const blocks = [
        ...content.matchAll(new RegExp('```' + PROJECT_CHAT_HANDOVER_BLOCK + '\\r?\\n([\\s\\S]*?)```', 'g')),
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
        if (typeof candidate.agentId !== 'string' || !AGENT_ID.test(candidate.agentId)) continue;
        let note = '';
        if (candidate.note !== undefined) {
            if (typeof candidate.note !== 'string') continue;
            note = candidate.note.slice(0, 2000);
        }
        return { agentId: candidate.agentId.toLowerCase(), note };
    }
    return null;
}
