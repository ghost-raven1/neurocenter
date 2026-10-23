import {isAxiosError} from 'axios';
import type {ProjectChatDraft, ProjectChatMessage} from './types';

export const PROJECT_CHAT_MESSAGE_BYTES = 128 * 1024;
export const projectChatRequestKey = (): string => crypto.randomUUID();
export const emptyProjectChatDraft = (): ProjectChatDraft => ({body: '', delivery: 'people', agentIds: []});
export const projectChatLocalAnchor = (value: string): string | undefined => /^#project-chat-message-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value : undefined;

/** A tail refresh may update an existing response, while an old history page may only prepend. */
export function mergeProjectMessages(previous: ProjectChatMessage[], incoming: ProjectChatMessage[], history = false): ProjectChatMessage[] {
    const entries = new Map(previous.map(value => [value.id, value]));
    for (const value of incoming) if (!history || !entries.has(value.id)) entries.set(value.id, value);
    return [...entries.values()].sort((a, b) => BigInt(a.position) < BigInt(b.position) ? -1 : BigInt(a.position) > BigInt(b.position) ? 1 : 0);
}

export function projectChatAuthor(message: ProjectChatMessage): string {
    return message.kind === 'summary' ? 'Итог по стеку' : message.kind === 'agent' ? message.agent?.name || 'Агент' : message.author?.displayName || message.author?.email || 'Участник проекта';
}

/** A missing transport acknowledgement never permits silently changing the saved request. */
export function projectChatAmbiguous(cause: unknown): boolean {
    return !isAxiosError(cause) || !cause.response || cause.response.status >= 500 || cause.response.status === 408;
}
