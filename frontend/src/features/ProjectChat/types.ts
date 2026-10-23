import type {IModelChatParticipant} from '../ModelChat/types';

export interface ProjectChatMember {email: string; displayName: string; role: string;}
export interface ProjectChatAgent {id: string; name: string; slug: string; modelId: string; modelPin: string;}
export interface ProjectChatMessage {
    id: string; position: string; kind: 'user' | 'agent' | 'summary';
    author: {email: string; displayName: string} | null; agent: ProjectChatAgent | null;
    content: string; replyToId: string | null; sourceMessageId: string | null;
    status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; error?: string | null;
    createdAt: string; canRetry?: boolean; canCancel?: boolean;
}
export interface ProjectChatRoom {projectId: string; revision: number; agentIds: string[]; modelId: string | null; modelPin: string | null;}
export interface ProjectChatHistory {hasMore: boolean; nextCursor: string | null;}
export interface ProjectChatPage {messages: ProjectChatMessage[]; history: ProjectChatHistory;}
export interface ProjectChatDetail extends ProjectChatPage {
    room: ProjectChatRoom; members: ProjectChatMember[]; agents: IModelChatParticipant[];
    canPost: boolean; canConfigure: boolean;
}
export interface ProjectChatIntent {requestKey: string; prompt: string; replyToId?: string; targetAgentIds?: string[];}
export interface ProjectChatReceipt {message: ProjectChatMessage; messages?: ProjectChatMessage[]; roomRevision: number;}
export interface ProjectChatDraft {
    body: string; reply?: ProjectChatMessage; delivery: 'group' | 'people' | 'selected'; agentIds: string[];
    pending?: ProjectChatIntent;
}
