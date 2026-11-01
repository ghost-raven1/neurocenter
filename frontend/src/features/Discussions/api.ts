import base from '../../core/api/base';
import type {
    ICatalogReaction,
    ICommentIntent,
    IDiscussionAttachment,
    IDiscussionComment,
    IDiscussionPage,
    IDiscussionTarget,
} from './interfaces';
const root = '/api/discussions';
const timeout = 20000;
const targetParams = (target: IDiscussionTarget) => ({ targetType: target.type, targetId: target.id });
const commentPath = (id: string) => root + '/comments/' + encodeURIComponent(id);

/** A retry reuses the exact comment and upload keys; likes set the desired state. */
export const discussionsApi = {
    list: (target: IDiscussionTarget, cursor?: string): Promise<IDiscussionPage> =>
        base
            .get<IDiscussionPage>(root, { params: { ...targetParams(target), cursor }, timeout })
            .then((value) => value.data),
    create: (target: IDiscussionTarget, intent: ICommentIntent): Promise<IDiscussionComment> =>
        base
            .post<IDiscussionComment>(root + '/comments', { ...targetParams(target), ...intent }, { timeout })
            .then((value) => value.data),
    get: (id: string): Promise<IDiscussionComment> =>
        base.get<IDiscussionComment>(commentPath(id), { timeout }).then((value) => value.data),
    edit: (id: string, body: string, expectedVersion: number): Promise<IDiscussionComment> =>
        base
            .patch<IDiscussionComment>(commentPath(id), { body, expectedVersion }, { timeout })
            .then((value) => value.data),
    remove: (id: string, expectedVersion: number): Promise<{ ok: true }> =>
        base
            .delete<{ ok: true }>(commentPath(id), { params: { expectedVersion }, timeout })
            .then((value) => value.data),
    upload: (
        target: IDiscussionTarget,
        file: File,
        key: string,
        onProgress: (value: number) => void,
    ): Promise<IDiscussionAttachment> =>
        base
            .post<IDiscussionAttachment>(root + '/attachments', file, {
                params: targetParams(target),
                timeout: 120000,
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-File-Name': encodeURIComponent(file.name),
                    'X-Request-Key': key,
                },
                onUploadProgress: (value) =>
                    onProgress(value.total ? Math.round((value.loaded / value.total) * 100) : 0),
            })
            .then((value) => value.data),
    removeUpload: (id: string): Promise<{ ok: true }> =>
        base
            .delete<{ ok: true }>(root + '/attachments/' + encodeURIComponent(id), { timeout })
            .then((value) => value.data),
    reaction: (catalogId: string): Promise<ICatalogReaction> =>
        base
            .get<ICatalogReaction>('/api/catalog-reactions', { params: { targetId: catalogId }, timeout })
            .then((value) => value.data),
    setReaction: (catalogId: string, liked: boolean): Promise<ICatalogReaction> => {
        const path = '/api/catalog-reactions',
            config = { params: { targetId: catalogId }, timeout };
        return (
            liked ? base.put<ICatalogReaction>(path, undefined, config) : base.delete<ICatalogReaction>(path, config)
        ).then((value) => value.data);
    },
};
