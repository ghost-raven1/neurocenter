export interface ProjectChatActivity {
    roomId: string; viewerEmail: string; observedAt: string;
    members: Array<{email: string; online: boolean; typing: boolean}>;
    receipts: Array<{messageId: string; readerEmails: string[]}>;
}
export interface ProjectChatActivityInput {
    sessionId: string; sequence: number; online: boolean; typing?: boolean; visibleMessageIds?: string[];
}
