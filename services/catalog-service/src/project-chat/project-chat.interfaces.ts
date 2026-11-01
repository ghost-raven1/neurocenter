import type { IAgentToolGrant } from '../agent-tools/agent-tools.interfaces';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import type { IAccessActor } from '../access/access.model';
import type { IChatAgentSnapshot, IChatParticipant } from '../model-chat/chat-group.interfaces';
import type { IChatUsage } from '../model-chat/chat.interfaces';
import type { IChatLearningReceipt } from '../model-chat/chat-learning-context.interfaces';

export type TProjectChatVisibility = 'PUBLIC' | 'PRIVATE';

export type TProjectChatKind = 'user' | 'agent' | 'summary';

export type TProjectChatStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type TProjectChatTransport = 'server' | 'device-codex';

export interface IProjectChatRoomKey {
    projectId: string;
    roomId: string;
}

export type TProjectChatDb = Pick<PoolClient, 'query'>;

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

export interface IProjectChatRoomRow {
    project_id: string;
    id?: string;
    title?: string;
    visibility?: TProjectChatVisibility;
    creator_email?: string | null;
    create_request_hash?: string | null;
    updated_at?: Date | string;
    revision: number;
    agent_ids: string[];
    model_id: string | null;
    model_pin: string | null;
}

export interface IProjectChatMessage {
    id: string;
    roomId?: string;
    position: string;
    kind: TProjectChatKind;
    content: string;
    author: { email: string; displayName: string } | null;
    agent: { id: string; name: string; slug: string; modelId: string; modelPin: string } | null;
    replyToId: string | null;
    sourceMessageId: string | null;
    status: TProjectChatStatus;
    error?: string;
    createdAt: string;
    canRetry: boolean;
    canCancel: boolean;
    learning?: IChatLearningReceipt;
    agentTools?: IAgentToolGrant;
    methodWorkflows?: import('../agent-method-workflows/chat-workflows.interfaces').IProjectChatMethodWorkflow[];
    methodWorkflowsHistory?: { hasMore: boolean; nextCursor: string | null };
}

export interface IProjectChatMessageRow {
    id: string;
    project_id: string;
    room_id?: string;
    position: string;
    kind: TProjectChatKind;
    content: string;
    author_email: string | null;
    author_name: string | null;
    author_role: string | null;
    reply_to_id: string | null;
    source_message_id: string | null;
    status: TProjectChatStatus;
    request_key: string | null;
    request_hash: string | null;
    target_agent_ids: string[];
    snapshot: IChatAgentSnapshot | null;
    generation: string;
    lease_until: Date | string | null;
    agent_tools_request?: IAgentToolGrant | null;
    error: string | null;
    usage: IChatUsage | null;
    learning: IChatLearningReceipt | null;
    created_at: Date | string;
}

export interface IProjectChatDetail {
    room: IProjectChatRoom;
    members: Array<{ email: string; displayName: string; role: string }>;
    agents: IChatParticipant[];
    messages: IProjectChatMessage[];
    history: { hasMore: boolean; nextCursor: string | null };
    canPost: boolean;
    canConfigure: boolean;
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
    members: Array<{ email: string; displayName: string; role: string }>;
}

export interface IProjectChatCreateRoomInput {
    requestKey: string;
    title: string;
    visibility: TProjectChatVisibility;
    memberEmails: string[];
}

export interface IProjectChatUpdateRoomInput {
    expectedRevision: number;
    title: string;
    memberEmails: string[];
}

export interface IProjectChatSendInput {
    requestKey: string;
    prompt: string;
    replyToId?: string;
    targetAgentIds?: string[];
    agentTools?: IAgentToolGrant;
}

export interface IProjectChatParticipantsInput {
    expectedRevision: number;
    modelId?: string;
    expectedModelPin?: string;
    agentIds: string[];
}

export interface IProjectChatRetryInput {
    requestKey: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Runtime validates the empty body; keep the existing generated transport schema.
export interface IProjectChatCancelInput {}

export interface IProjectChatReceipt {
    message: IProjectChatMessage;
    messages?: IProjectChatMessage[];
    roomRevision: number;
}

export interface IProjectChatHistory {
    messages: IProjectChatMessage[];
    history: { hasMore: boolean; nextCursor: string | null };
    roomRevision: number;
}

/** Paid execution is provided separately; the room owns admission, receipts and queue state. */
export interface IProjectChatInference {
    roster(
        req: Request,
        projectId: string,
        room: IProjectChatRoomRow,
        db?: TProjectChatDb,
    ): Promise<IChatParticipant[]>;
    resolve(
        req: Request,
        projectId: string,
        room: IProjectChatRoomRow,
        agentIds: string[],
        db?: TProjectChatDb,
    ): Promise<IChatAgentSnapshot[]>;
    assert(req: Request, projectId: string, snapshot: IChatAgentSnapshot, db?: TProjectChatDb): Promise<void>;
    transport(
        req: Request,
        projectId: string,
        snapshot: IChatAgentSnapshot,
        db?: TProjectChatDb,
    ): Promise<TProjectChatTransport>;
    infer(input: {
        req: Request;
        projectId: string;
        source: IProjectChatMessageRow;
        response: IProjectChatMessageRow;
        signal: AbortSignal;
    }): Promise<{
        content: string;
        usage?: IChatUsage;
        learning: IChatLearningReceipt;
        assertCurrent?: (db: TProjectChatDb) => Promise<void>;
    }>;
}

export interface IProjectChatJob {
    projectId: string;
    source: IProjectChatMessageRow;
    actor: IAccessActor;
    generation: string;
}
