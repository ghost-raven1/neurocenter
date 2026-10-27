import type {IModelChatParticipant} from '../ModelChat/types';
import type {AgentToolGrant} from '../AgentTools/types';
import type {AgentMethod,AgentMethodWorkflowAgentIdentity,AgentMethodWorkflowResult} from '../../../../services/shared/agent-method-workflow.cjs';

export const DEFAULT_PROJECT_CHAT_ROOM = '00000000-0000-0000-0000-000000000000';
export type ProjectChatVisibility = 'PUBLIC' | 'PRIVATE';
export interface ProjectChatMember {email: string; displayName: string; role: string;}
export interface ProjectChatAgent {id: string; name: string; slug: string; modelId: string; modelPin: string;}
/** Only server-published method facts are shared; private device payloads never enter the chat. */
export interface ProjectChatMethodWorkflow {
    jobId:string;workflowId:string;method:AgentMethod;agent:AgentMethodWorkflowAgentIdentity;
    state:'queued'|'running'|'reconciling'|'succeeded'|'failed'|'cancelled';percent:number|null;
    createdAt:string;startedAt:string|null;updatedAt:string;canCancel:boolean;publicationState:'pending'|'published'|'withheld';
    result?:AgentMethodWorkflowResult;
}
export interface ProjectChatMethodWorkflowHistory {hasMore:boolean;nextCursor:string|null;}
export interface ProjectChatMethodWorkflowPage extends ProjectChatMethodWorkflowHistory {items:ProjectChatMethodWorkflow[];}
export interface ProjectChatMessage {
    id: string; roomId?: string; position: string; kind: 'user' | 'agent' | 'summary';
    author: {email: string; displayName: string} | null; agent: ProjectChatAgent | null;
    content: string; replyToId: string | null; sourceMessageId: string | null;
    status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; error?: string | null;
    createdAt: string; canRetry?: boolean; canCancel?: boolean; agentTools?: AgentToolGrant;methodWorkflows?:ProjectChatMethodWorkflow[];methodWorkflowsHistory?:ProjectChatMethodWorkflowHistory;
}
export interface ProjectChatRoom {projectId: string; id?: string; title?: string; visibility?: ProjectChatVisibility; creatorEmail?: string | null; memberEmails?: string[]; canManage?: boolean; revision: number; agentIds: string[]; modelId: string | null; modelPin: string | null;}
export interface ProjectChatHistory {hasMore: boolean; nextCursor: string | null;}
export interface ProjectChatPage {messages: ProjectChatMessage[]; history: ProjectChatHistory;}
export interface ProjectChatDetail extends ProjectChatPage {
    room: ProjectChatRoom; members: ProjectChatMember[]; agents: IModelChatParticipant[];
    canPost: boolean; canConfigure: boolean;
}
export interface ProjectChatIntent {requestKey: string; prompt: string; replyToId?: string; targetAgentIds?: string[]; agentTools?: AgentToolGrant;}
export interface ProjectChatReceipt {message: ProjectChatMessage; messages?: ProjectChatMessage[]; roomRevision: number;}
export interface ProjectChatDraft {
    body: string; reply?: ProjectChatMessage; delivery: 'group' | 'people' | 'selected'; agentIds: string[];
    pending?: ProjectChatIntent;
}

export interface ProjectChatRoomSummary {id: string; title: string; visibility: ProjectChatVisibility; revision: number; updatedAt: string; canManage: boolean; memberEmails: string[]}
export interface ProjectChatRooms {rooms: ProjectChatRoomSummary[]; canCreate: boolean; members: ProjectChatMember[]}
export interface ProjectChatCreateRoom {requestKey: string; title: string; visibility: ProjectChatVisibility; memberEmails: string[]}
export interface ProjectChatUpdateRoom {expectedRevision: number; title: string; memberEmails: string[]}
