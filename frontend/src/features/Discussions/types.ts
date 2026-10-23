export interface DiscussionTarget {type: 'catalog' | 'help'; id: string}
export interface DiscussionAttachment {id: string; name: string; mediaType: string; bytes: number; url: string}
export interface DiscussionComment {
    id: string; parentId: string | null; body: string; author: {email: string; displayName: string};
    version: number; createdAt: string; updatedAt: string; deleted: boolean;
    attachments: DiscussionAttachment[]; canEdit: boolean; canDelete: boolean;
}
export interface DiscussionPage {items: DiscussionComment[]; nextCursor: string | null; canComment: boolean; canAttach: boolean; attachmentsUnavailableReason?: string}
export interface CatalogReaction {liked: boolean; count: number}
export interface CommentIntent {body: string; parentId?: string; attachmentIds: string[]; requestKey: string}
export interface DraftAttachment {
    key: string; file: File; uploaded?: DiscussionAttachment; progress: number; error?: string;
}
export interface DiscussionDraft {body: string; parentId?: string; files: DraftAttachment[]; pending?: CommentIntent}
