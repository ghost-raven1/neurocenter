export interface DiscussionTarget {
    type: 'catalog' | 'help';
    id: string;
}
export interface DiscussionAttachment {
    id: string;
    name: string;
    mediaType: string;
    bytes: number;
    url: string;
}
export interface DiscussionComment {
    id: string;
    parentId: string | null;
    body: string;
    author: { email: string; displayName: string };
    version: number;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    canEdit: boolean;
    canDelete: boolean;
    attachments: DiscussionAttachment[];
}
export interface CommentRow {
    id: string;
    target_type: 'catalog' | 'help';
    target_id: string;
    parent_id: string | null;
    body: string;
    author_email: string;
    author_name: string;
    version: number;
    created_at: Date | string;
    updated_at: Date | string;
    deleted_at: Date | string | null;
    request_key: string;
    request_hash: string;
}
export interface AttachmentRow {
    id: string;
    target_type: 'catalog' | 'help';
    target_id: string;
    owner_email: string;
    name: string;
    media_type: string;
    bytes: number;
    sha256: string;
    storage_id: string;
    bucket: string;
    object_key: string;
    version_id: string | null;
    state: 'UPLOADING' | 'READY' | 'DELETED' | 'PURGED';
    comment_id: string | null;
    request_key: string;
    created_at: Date | string;
}
