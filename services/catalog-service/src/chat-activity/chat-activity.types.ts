/** A browser tab owns one ordered session; receipts describe only explicitly visible human messages. */
export interface ChatActivitySessionInput {sessionId: string; sequence: number; online: boolean}
export interface ProjectChatActivityInput extends ChatActivitySessionInput {typing?: boolean; visibleMessageIds?: string[]}
export interface ProjectChatActivity {
    roomId: string; viewerEmail: string; observedAt: string;
    members: Array<{email: string; online: boolean; typing: boolean}>;
    receipts: Array<{messageId: string; readerEmails: string[]}>;
}
