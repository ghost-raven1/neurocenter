/**
 * FR-309: an agent shares context elements (state/result/decision) with another agent,
 * a user (private dialogue) or the team (public room). The directive travels inside a
 * published answer as a fenced JSON block; the runner executes it in the finalization
 * transaction with a per-item provenance audit (NFR-4). Malformed blocks never fail
 * the published answer; sharing is gated on the agent's access to the target room.
 */
export const PROJECT_CHAT_SHARE_ACTION = 'project.chat.agent.share';
export const PROJECT_CHAT_SHARE_BLOCK = 'neurocenter-share';
export const PROJECT_CHAT_SHARE_KINDS = ['state', 'result', 'decision'] as const;
export type TProjectChatShareKind = (typeof PROJECT_CHAT_SHARE_KINDS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 8;
const MAX_CONTENT_BYTES = 8 * 1024 ** 2;

export interface IProjectChatShareItem {
    kind: TProjectChatShareKind;
    content: string;
    /** Reference to the published source message (what-ref); defaults to the carrying answer. */
    ref?: string;
}
export interface IProjectChatShare {
    /** Target room the agent must be a participant of (room-access gate). */
    roomId: string;
    items: IProjectChatShareItem[];
}

/** Every valid directive in the answer is returned (up to four); malformed blocks are skipped. */
export function parseProjectChatShares(content: string): IProjectChatShare[] {
    const result: IProjectChatShare[] = [];
    const blocks = [...content.matchAll(new RegExp('```' + PROJECT_CHAT_SHARE_BLOCK + '\\r?\\n([\\s\\S]*?)```', 'g'))];
    for (const block of blocks) {
        if (result.length >= 4) break;
        let value: unknown;
        try {
            value = JSON.parse(block[1].trim());
        } catch {
            continue;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const candidate = value as Record<string, unknown>;
        if (typeof candidate.roomId !== 'string' || !UUID.test(candidate.roomId)) continue;
        if (!Array.isArray(candidate.items) || !candidate.items.length || candidate.items.length > MAX_ITEMS) continue;
        const items: IProjectChatShareItem[] = [];
        let valid = true;
        for (const raw of candidate.items) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                valid = false;
                break;
            }
            const item = raw as Record<string, unknown>;
            if (typeof item.kind !== 'string' || !(PROJECT_CHAT_SHARE_KINDS as readonly string[]).includes(item.kind)) {
                valid = false;
                break;
            }
            if (
                typeof item.content !== 'string' ||
                !item.content.trim() ||
                Buffer.byteLength(item.content) > MAX_CONTENT_BYTES
            ) {
                valid = false;
                break;
            }
            const parsed: IProjectChatShareItem = { kind: item.kind as TProjectChatShareKind, content: item.content };
            if (item.ref !== undefined) {
                if (typeof item.ref !== 'string' || !UUID.test(item.ref)) {
                    valid = false;
                    break;
                }
                parsed.ref = item.ref.toLowerCase();
            }
            items.push(parsed);
        }
        if (valid) result.push({ roomId: candidate.roomId.toLowerCase(), items });
    }
    return result;
}
