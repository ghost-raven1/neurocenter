import {emptyProjectChatDraft, PROJECT_CHAT_MESSAGE_BYTES} from './model';
import type {ProjectChatDraft, ProjectChatMessage} from './types';

const drafts = new Map<string, ProjectChatDraft>();
const prefix = 'neurocenter:project-chat-draft:v1:';
const maxBytes = 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const identifiers = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every(identifier);
const bytes = (value: string): number => new TextEncoder().encode(value).length;

/** The same person keeps recovery after a role change; every project and dialogue stays isolated. */
export function projectChatDraftScope(draftKey: string): string {
    try {
        const parts: unknown = JSON.parse(draftKey);
        if (Array.isArray(parts) && parts.length === 3 && parts.every(part => typeof part === 'string')) {
            const auth: unknown = JSON.parse(parts[0]);
            if (object(auth) && identifier(auth.id) && identifier(auth.email)) return JSON.stringify([[auth.id, auth.email], parts[1], parts[2]]);
        }
    } catch { /* Unknown key formats retain their own isolation. */ }
    return draftKey;
}

function validReply(value: unknown): value is ProjectChatMessage {
    if (!object(value)) return false;
    return identifier(value.id) && typeof value.position === 'string' && ['user', 'agent', 'summary'].includes(String(value.kind))
        && typeof value.content === 'string' && typeof value.createdAt === 'string'
        && ['queued', 'running', 'done', 'failed', 'cancelled'].includes(String(value.status))
        && (value.author === null || object(value.author) && typeof value.author.displayName === 'string' && typeof value.author.email === 'string')
        && (value.agent === null || object(value.agent) && identifier(value.agent.id) && typeof value.agent.name === 'string')
        && (value.replyToId === null || identifier(value.replyToId)) && (value.sourceMessageId === null || identifier(value.sourceMessageId));
}

function validGrant(value: unknown): boolean {
    if (!object(value) || value.protocol !== 'json-actions-v1' || typeof value.rag !== 'boolean') return false;
    const chats = value.publicChats;
    return (value.systemRoles === undefined || typeof value.systemRoles === 'boolean')
        && (chats === undefined || object(chats) && identifier(chats.modelId) && typeof chats.expectedModelPin === 'string'
            && /^[a-f0-9]{64}$/.test(chats.expectedModelPin) && chats.consent === true && (chats.roomId === undefined || identifier(chats.roomId))
            && Object.keys(chats).every(key => ['modelId', 'expectedModelPin', 'consent', 'roomId'].includes(key)))
        && Object.keys(value).every(key => ['protocol', 'rag', 'systemRoles', 'publicChats'].includes(key));
}

/** Browser data is untrusted; only a bounded draft and its original immutable request may be restored. */
function validDraft(value: unknown): value is ProjectChatDraft {
    if (!object(value) || typeof value.body !== 'string' || !['people', 'group', 'selected'].includes(String(value.delivery)) || !identifiers(value.agentIds)) return false;
    if (value.reply !== undefined && !validReply(value.reply)) return false;
    if (value.pending === undefined) return true;
    const pending = value.pending;
    return object(pending) && identifier(pending.requestKey) && typeof pending.prompt === 'string' && !!pending.prompt.trim()
        && pending.prompt === value.body.trim() && bytes(pending.prompt) <= PROJECT_CHAT_MESSAGE_BYTES
        && (pending.replyToId === undefined || identifier(pending.replyToId) && pending.replyToId === value.reply?.id)
        && (pending.targetAgentIds === undefined || identifiers(pending.targetAgentIds))
        && (pending.agentTools === undefined || validGrant(pending.agentTools))
        && Object.keys(pending).every(key => ['requestKey', 'prompt', 'replyToId', 'targetAgentIds', 'agentTools'].includes(key));
}

export function readProjectChatDraft(scope: string): ProjectChatDraft {
    const cached = drafts.get(scope); if (cached) return cached;
    try {
        const raw = sessionStorage.getItem(prefix + scope);
        if (raw && bytes(raw) <= maxBytes) {
            const value: unknown = JSON.parse(raw);
            if (object(value) && value.version === 1 && validDraft(value.draft)) {drafts.set(scope, value.draft); return value.draft;}
        }
    } catch { /* A broken or inaccessible draft cannot restore another scope. */ }
    return emptyProjectChatDraft();
}

/** Keep editing in memory if storage is denied; the caller must persist pending work before POST. */
export function saveProjectChatDraft(scope: string, draft: ProjectChatDraft): boolean {
    drafts.set(scope, draft);
    try {
        if (!draft.body && !draft.reply && !draft.pending) {sessionStorage.removeItem(prefix + scope); drafts.delete(scope); return true;}
        const raw = JSON.stringify({version: 1, draft});
        if (bytes(raw) > maxBytes || !validDraft(draft)) return false;
        sessionStorage.setItem(prefix + scope, raw); return true;
    } catch {return false;}
}
