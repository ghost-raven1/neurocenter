import {isAxiosError} from 'axios';
import type {DiscussionComment, DiscussionDraft, DiscussionTarget} from './types';
export const MAX_COMMENT_FILES = 5;
export const MAX_COMMENT_BYTES = 10 * 1024 * 1024;
export const MAX_COMMENT_BODY_BYTES = 16000;
export const discussionKey = (scope: string, target: DiscussionTarget): string => JSON.stringify([scope, target.type, target.id]);
export const emptyDraft = (): DiscussionDraft => ({body: '', files: []});
export const requestKey = (): string => crypto.randomUUID();
export const ambiguousFailure = (cause: unknown): boolean => !isAxiosError(cause) || !cause.response || cause.response.status >= 500 || cause.response.status === 408;

/** Keep the newest receipt when a slower read finishes after a mutation. */
export function mergeComments(previous: DiscussionComment[], incoming: DiscussionComment[]): DiscussionComment[] {
    const values = new Map(previous.map(value => [value.id, value]));
    for (const value of incoming) {
        const old = values.get(value.id);
        if (!old || value.version >= old.version) values.set(value.id, value);
    }
    return [...values.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Only authenticated attachment downloads supplied by this API become links. */
export function attachmentUrl(value: string): string | undefined {
    return /^\/api\/discussions\/attachments\/[a-zA-Z0-9-]+\/content$/.test(value) ? value : undefined;
}
export function fileSize(bytes: number): string {
    return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' МиБ' : Math.max(1, Math.ceil(bytes / 1024)) + ' КиБ';
}
