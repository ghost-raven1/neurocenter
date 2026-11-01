export interface IDiscussionTarget {
    type: 'catalog' | 'help';
    id: string;
}
export interface IDiscussionAttachment {
    id: string;
    name: string;
    mediaType: string;
    bytes: number;
    url: string;
}
export interface IDiscussionComment {
    id: string;
    parentId: string | null;
    body: string;
    author: { email: string; displayName: string };
    version: number;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    attachments: IDiscussionAttachment[];
    canEdit: boolean;
    canDelete: boolean;
}
export interface IDiscussionPage {
    items: IDiscussionComment[];
    nextCursor: string | null;
    totalCount?: number;
    canComment: boolean;
    canAttach: boolean;
    attachmentsUnavailableReason?: string;
}
export interface ICatalogReaction {
    liked: boolean;
    count: number;
    commentCount?: number;
}
export interface ICommentIntent {
    body: string;
    parentId?: string;
    attachmentIds: string[];
    requestKey: string;
}
export interface IDraftAttachment {
    key: string;
    file: File;
    uploaded?: IDiscussionAttachment;
    progress: number;
    error?: string;
}
export interface IDiscussionDraft {
    body: string;
    parentId?: string;
    files: IDraftAttachment[];
    pending?: ICommentIntent;
}
