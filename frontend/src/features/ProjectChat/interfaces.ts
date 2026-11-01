import type { IModelChatParticipant } from '../ModelChat/interfaces';
import type { IAgentToolGrant } from '../AgentTools/interfaces';
import type {
    TAgentMethod,
    IAgentMethodWorkflowAgentIdentity,
    IAgentMethodWorkflowResult,
} from '../../../../services/shared/agent-method-workflow.cjs';

export type TProjectChatVisibility = 'PUBLIC' | 'PRIVATE';

export interface IProjectChatMember {
    email: string;
    displayName: string;
    role: string;
}

export interface IProjectChatAgent {
    id: string;
    name: string;
    slug: string;
    modelId: string;
    modelPin: string;
}

/** Only server-published method facts are shared; private device payloads never enter the chat. */
export interface IProjectChatMethodWorkflow {
    jobId: string;
    workflowId: string;
    method: TAgentMethod;
    agent: IAgentMethodWorkflowAgentIdentity;
    state: 'queued' | 'running' | 'reconciling' | 'succeeded' | 'failed' | 'cancelled';
    percent: number | null;
    createdAt: string;
    startedAt: string | null;
    updatedAt: string;
    canCancel: boolean;
    publicationState: 'pending' | 'published' | 'withheld';
    result?: IAgentMethodWorkflowResult;
}

export interface IProjectChatMethodWorkflowHistory {
    hasMore: boolean;
    nextCursor: string | null;
}

export interface IProjectChatMessage {
    id: string;
    roomId?: string;
    position: string;
    kind: 'user' | 'agent' | 'summary';
    author: { email: string; displayName: string } | null;
    agent: IProjectChatAgent | null;
    content: string;
    replyToId: string | null;
    sourceMessageId: string | null;
    status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
    error?: string | null;
    createdAt: string;
    canRetry?: boolean;
    canCancel?: boolean;
    agentTools?: IAgentToolGrant;
    methodWorkflows?: IProjectChatMethodWorkflow[];
    methodWorkflowsHistory?: IProjectChatMethodWorkflowHistory;
}

export interface IProjectChatRoom {
    projectId: string;
    id?: string;
    title?: string;
    visibility?: TProjectChatVisibility;
    creatorEmail?: string | null;
    memberEmails?: string[];
    canManage?: boolean;
    revision: number;
    agentIds: string[];
    modelId: string | null;
    modelPin: string | null;
}

export interface IProjectChatHistory {
    hasMore: boolean;
    nextCursor: string | null;
}

export interface IProjectChatPage {
    messages: IProjectChatMessage[];
    history: IProjectChatHistory;
}

export interface IProjectChatDetail extends IProjectChatPage {
    room: IProjectChatRoom;
    members: IProjectChatMember[];
    agents: IModelChatParticipant[];
    canPost: boolean;
    canConfigure: boolean;
}

export interface IProjectChatIntent {
    requestKey: string;
    prompt: string;
    replyToId?: string;
    targetAgentIds?: string[];
    agentTools?: IAgentToolGrant;
}

export interface IProjectChatReceipt {
    message: IProjectChatMessage;
    messages?: IProjectChatMessage[];
    roomRevision: number;
}

export interface IProjectChatDraft {
    body: string;
    reply?: IProjectChatMessage;
    delivery: 'group' | 'people' | 'selected';
    agentIds: string[];
    pending?: IProjectChatIntent;
}

export interface IProjectChatRoomSummary {
    id: string;
    title: string;
    visibility: TProjectChatVisibility;
    revision: number;
    updatedAt: string;
    canManage: boolean;
    memberEmails: string[];
}

export interface IProjectChatRooms {
    rooms: IProjectChatRoomSummary[];
    canCreate: boolean;
    members: IProjectChatMember[];
}

export interface IProjectChatCreateRoom {
    requestKey: string;
    title: string;
    visibility: TProjectChatVisibility;
    memberEmails: string[];
}

export interface IProjectChatUpdateRoom {
    expectedRevision: number;
    title: string;
    memberEmails: string[];
}
