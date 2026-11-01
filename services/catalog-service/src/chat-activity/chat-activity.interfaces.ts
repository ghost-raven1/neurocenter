/** A browser tab owns one ordered session; receipts describe only explicitly visible human messages. */
export interface IChatActivitySessionInput {
    sessionId: string;
    sequence: number;
    online: boolean;
}
export interface IProjectChatActivityInput extends IChatActivitySessionInput {
    typing?: boolean;
    visibleMessageIds?: string[];
}
export interface IProjectChatActivity {
    roomId: string;
    viewerEmail: string;
    observedAt: string;
    members: Array<{ email: string; online: boolean; typing: boolean }>;
    receipts: Array<{ messageId: string; readerEmails: string[] }>;
}
