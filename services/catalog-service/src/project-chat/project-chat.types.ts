import type { Request } from 'express';
import type { PoolClient } from 'pg';
import type { IAccessActor } from '../access/access.model';
import type { ChatAgentSnapshot, ChatParticipant } from '../model-chat/chat-group.types';
import type { ChatUsage } from '../model-chat/chat.types';
import type { ChatLearningReceipt } from '../model-chat/chat-learning-context.types';

export const DEFAULT_PROJECT_CHAT_ROOM = '00000000-0000-0000-0000-000000000000';
export const projectChatRoomId = (row: {id?: string}): string => row.id ?? DEFAULT_PROJECT_CHAT_ROOM;
export type ProjectChatVisibility = 'PUBLIC' | 'PRIVATE';
export type ProjectChatKind = 'user' | 'agent' | 'summary';
export type ProjectChatStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type ProjectChatTransport = 'server' | 'device-codex';
export interface ProjectChatRoomKey { projectId: string; roomId: string }
export type ProjectChatDb = Pick<PoolClient, 'query'>;
export interface ProjectChatRoom {
    projectId: string; id?: string; title?: string; visibility?: ProjectChatVisibility; creatorEmail?: string | null; memberEmails?: string[]; canManage?: boolean; revision: number; agentIds: string[]; modelId: string | null; modelPin: string | null;
}
export interface ProjectChatRoomRow {
    project_id: string; id?: string; title?: string; visibility?: ProjectChatVisibility; creator_email?: string | null; create_request_hash?: string | null; updated_at?: Date | string; revision: number; agent_ids: string[]; model_id: string | null; model_pin: string | null;
}
export interface ProjectChatMessage {
    id: string; roomId?: string; position: string; kind: ProjectChatKind; content: string;
    author: { email: string; displayName: string } | null;
    agent: { id: string; name: string; slug: string; modelId: string; modelPin: string } | null;
    replyToId: string | null; sourceMessageId: string | null; status: ProjectChatStatus;
    error?: string; createdAt: string; canRetry: boolean; canCancel: boolean;
    learning?: ChatLearningReceipt;
}
export interface ProjectChatMessageRow {
    id: string; project_id: string; room_id?: string; position: string; kind: ProjectChatKind; content: string;
    author_email: string | null; author_name: string | null; author_role: string | null;
    reply_to_id: string | null; source_message_id: string | null; status: ProjectChatStatus;
    request_key: string | null; request_hash: string | null; target_agent_ids: string[];
    snapshot: ChatAgentSnapshot | null; generation: string; lease_until: Date | string | null;
    error: string | null; usage: ChatUsage | null; learning: ChatLearningReceipt | null; created_at: Date | string;
}
export interface ProjectChatDetail {
    room: ProjectChatRoom; members: Array<{ email: string; displayName: string; role: string }>;
    agents: ChatParticipant[]; messages: ProjectChatMessage[];
    history: { hasMore: boolean; nextCursor: string | null }; canPost: boolean; canConfigure: boolean;
}
export interface ProjectChatRoomSummary {id: string; title: string; visibility: ProjectChatVisibility; revision: number; updatedAt: string; canManage: boolean; memberEmails: string[]}
export interface ProjectChatRooms {rooms: ProjectChatRoomSummary[]; canCreate: boolean; members: Array<{email: string; displayName: string; role: string}>}
export interface ProjectChatCreateRoomInput {requestKey: string; title: string; visibility: ProjectChatVisibility; memberEmails: string[]}
export interface ProjectChatUpdateRoomInput {expectedRevision: number; title: string; memberEmails: string[]}
export interface ProjectChatSendInput {
    requestKey: string; prompt: string; replyToId?: string; targetAgentIds?: string[];
}
export interface ProjectChatParticipantsInput { expectedRevision: number; modelId?: string; expectedModelPin?: string; agentIds: string[] }
export interface ProjectChatRetryInput { requestKey: string }
export interface ProjectChatCancelInput {}
export interface ProjectChatReceipt { message: ProjectChatMessage; messages?: ProjectChatMessage[]; roomRevision: number }
export interface ProjectChatHistory { messages: ProjectChatMessage[]; history: { hasMore: boolean; nextCursor: string | null }; roomRevision: number }
/** Paid execution is provided separately; the room owns admission, receipts and queue state. */
export interface ProjectChatInference {
    roster(req: Request, projectId: string, room: ProjectChatRoomRow, db?: ProjectChatDb): Promise<ChatParticipant[]>;
    resolve(req: Request, projectId: string, room: ProjectChatRoomRow, agentIds: string[], db?: ProjectChatDb): Promise<ChatAgentSnapshot[]>;
    assert(req: Request, projectId: string, snapshot: ChatAgentSnapshot, db?: ProjectChatDb): Promise<void>;
    transport(req: Request, projectId: string, snapshot: ChatAgentSnapshot, db?: ProjectChatDb): Promise<ProjectChatTransport>;
    infer(input: { req: Request; projectId: string; source: ProjectChatMessageRow; response: ProjectChatMessageRow; signal: AbortSignal }): Promise<{ content: string; usage?: ChatUsage; learning: ChatLearningReceipt }>;
}
export interface ProjectChatJob {
    projectId: string; source: ProjectChatMessageRow; actor: IAccessActor; generation: string;
}
export const projectChatRoomView = (row: ProjectChatRoomRow): ProjectChatRoom => ({ projectId: row.project_id, id: projectChatRoomId(row), title: row.title ?? 'Общий чат', visibility: row.visibility ?? 'PUBLIC', creatorEmail: row.creator_email ?? null,
    revision: Number(row.revision), agentIds: row.agent_ids, modelId: row.model_id, modelPin: row.model_pin });
export const emptyProjectChatRoom = (projectId: string): ProjectChatRoomRow => ({ project_id: projectId, id: DEFAULT_PROJECT_CHAT_ROOM, title: 'Общий чат', visibility: 'PUBLIC', creator_email: null, revision: 0, agent_ids: [], model_id: null, model_pin: null });
