import base from '../../core/api/base';
import type {CatalogReaction, CommentIntent, DiscussionAttachment, DiscussionComment, DiscussionPage, DiscussionTarget} from './types';
const root = '/api/discussions';
const timeout = 20000;
const targetParams = (target: DiscussionTarget) => ({targetType: target.type, targetId: target.id});
const commentPath = (id: string) => root + '/comments/' + encodeURIComponent(id);

/** A retry reuses the exact comment and upload keys; likes set the desired state. */
export const discussionsApi = {
    list: (target: DiscussionTarget, cursor?: string): Promise<DiscussionPage> => base.get<DiscussionPage>(root, {params: {...targetParams(target), cursor}, timeout}).then(value => value.data),
    create: (target: DiscussionTarget, intent: CommentIntent): Promise<DiscussionComment> => base.post<DiscussionComment>(root + '/comments', {...targetParams(target), ...intent}, {timeout}).then(value => value.data),
    get: (id: string): Promise<DiscussionComment> => base.get<DiscussionComment>(commentPath(id), {timeout}).then(value => value.data),
    edit: (id: string, body: string, expectedVersion: number): Promise<DiscussionComment> => base.patch<DiscussionComment>(commentPath(id), {body, expectedVersion}, {timeout}).then(value => value.data),
    remove: (id: string, expectedVersion: number): Promise<{ok: true}> => base.delete<{ok: true}>(commentPath(id), {params: {expectedVersion}, timeout}).then(value => value.data),
    upload: (target: DiscussionTarget, file: File, key: string, onProgress: (value: number) => void): Promise<DiscussionAttachment> => base.post<DiscussionAttachment>(root + '/attachments', file, {
        params: targetParams(target), timeout: 120000, headers: {'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Request-Key': key},
        onUploadProgress: value => onProgress(value.total ? Math.round(value.loaded / value.total * 100) : 0),
    }).then(value => value.data),
    removeUpload: (id: string): Promise<{ok: true}> => base.delete<{ok: true}>(root + '/attachments/' + encodeURIComponent(id), {timeout}).then(value => value.data),
    reaction: (catalogId: string): Promise<CatalogReaction> => base.get<CatalogReaction>('/api/catalog-reactions', {params: {targetId: catalogId}, timeout}).then(value => value.data),
    setReaction: (catalogId: string, liked: boolean): Promise<CatalogReaction> => {
        const path = '/api/catalog-reactions', config = {params: {targetId: catalogId}, timeout};
        return (liked ? base.put<CatalogReaction>(path, undefined, config) : base.delete<CatalogReaction>(path, config)).then(value => value.data);
    },
};
