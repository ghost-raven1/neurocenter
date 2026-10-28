import type {IModelChatTurn} from './types';

const prefix = 'neurocenter:model-chat-submit:v1:';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const identifiers = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(identifier);
const digest = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Auth changes fence requests; recovery text still belongs to the same person. */
export function modelChatSubmissionKey(scope: string, modelId: string, projectId?: string, conversationId?: string): string {
    let identity: unknown = scope;
    try {const auth: unknown = JSON.parse(scope); if (object(auth) && identifier(auth.id) && identifier(auth.email)) identity = [auth.id, auth.email];} catch { /* Non-JSON scopes retain their own isolation. */ }
    return prefix + JSON.stringify([identity, modelId, projectId ?? null, conversationId ?? null]);
}

function validResearch(value: unknown): boolean {
    if (!object(value) || typeof value.project !== 'boolean') return false;
    const external = value.external;
    return external === undefined || object(external) && identifier(external.assetId) && Number.isSafeInteger(external.version) && Number(external.version) > 0 && digest(external.manifest);
}

function validGrant(value: unknown): boolean {
    if (!object(value) || value.protocol !== 'json-actions-v1' || typeof value.rag !== 'boolean' || value.systemRoles !== undefined && typeof value.systemRoles !== 'boolean') return false;
    const chats = value.publicChats;
    return chats === undefined || object(chats) && identifier(chats.modelId) && digest(chats.expectedModelPin) && chats.consent === true && (chats.roomId === undefined || identifier(chats.roomId));
}

/** Browser storage is untrusted; restore only bounded request input, never an answer or an automatic send. */
export function readModelChatSubmission(key: string): IModelChatTurn | null {
    try {
        const raw = sessionStorage.getItem(key); if (!raw || raw.length > 1024 * 1024) return null;
        const value: unknown = JSON.parse(raw);
        if (!object(value) || value.version !== 1 || !object(value.turn)) return null;
        const turn = value.turn;
        if (!identifier(turn.requestId) || typeof turn.prompt !== 'string' || new TextEncoder().encode(turn.prompt).length > 128 * 1024
            || !identifiers(turn.attachmentIds, 5) || !turn.prompt.trim() && !turn.attachmentIds.length
            || typeof turn.createdAt !== 'string' || turn.createdAt.length > 64
            || turn.targetAgentIds !== undefined && !identifiers(turn.targetAgentIds, 256)
            || turn.research !== undefined && !validResearch(turn.research) || turn.agentTools !== undefined && !validGrant(turn.agentTools)) return null;
        return {requestId: turn.requestId, id: 'client:' + turn.requestId, prompt: turn.prompt, attachmentIds: turn.attachmentIds, createdAt: turn.createdAt,
            status: 'failed', error: typeof turn.error === 'string' ? turn.error.slice(0, 2000) : 'Результат запроса не подтверждён. Можно явно повторить запрос с прежним ключом.',
            ...(turn.targetAgentIds ? {targetAgentIds: turn.targetAgentIds} : {}), ...(turn.research ? {research: turn.research as IModelChatTurn['research']} : {}),
            ...(turn.agentTools ? {agentTools: turn.agentTools as IModelChatTurn['agentTools']} : {})};
    } catch {return null;}
}

/** Persist before dispatch so clearing the composer cannot discard an unacknowledged request. */
export function saveModelChatSubmission(key: string, turn: IModelChatTurn): boolean {
    try {
        const {requestId, prompt, attachmentIds, createdAt, targetAgentIds, research, agentTools, error} = turn;
        sessionStorage.setItem(key, JSON.stringify({version: 1, turn: {requestId, prompt, attachmentIds, createdAt, targetAgentIds, research, agentTools, error}}));
        return true;
    } catch {return false;}
}

/** A late acknowledgement cannot remove a different newer local request. */
export function clearModelChatSubmission(key: string, requestId?: string): void {
    try {if (!requestId || readModelChatSubmission(key)?.requestId === requestId) sessionStorage.removeItem(key);} catch { /* Keep the visible state usable if storage becomes unavailable. */ }
}
