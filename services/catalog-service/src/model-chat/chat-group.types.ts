import type { AgentDefinition } from '../../../shared/project-agents.cjs';
import type { IModel } from '../models/model.types';
import type { ChatTurn, ChatUsage } from './chat.types';

export interface ChatParticipant {
    agentId: string;
    name: string;
    slug: string;
    status: 'active' | 'disabled' | 'removed' | 'blocked';
    reason?: string;
    modelId?: string;
    modelName?: string;
}
export interface ChatAgentSnapshot {
    agentId: string;
    name: string;
    slug: string;
    version: number;
    manifest: string;
    definition: AgentDefinition;
    modelId: string;
    modelName: string;
    modelPin: string;
    sha256: string;
}
export interface ChatAgentResponse {
    id: string;
    agentId: string;
    name: string;
    slug: string;
    version: number;
    modelId: string;
    modelName: string;
    modelPin: string;
    status: ChatTurn['status'];
    executionState?: ChatTurn['executionState'];
    processingStage: ChatTurn['processingStage'];
    answer?: NonNullable<ChatTurn['answer']>;
    error?: string;
}
export interface ChatResponseRow {
    execution_state?: ChatTurn['executionState'];
    id: string;
    conversation_id: string;
    turn_id: string;
    agent_id: string;
    snapshot: ChatAgentSnapshot;
    request_id: string;
    status: ChatTurn['status'];
    processing_stage: ChatTurn['processingStage'];
    answer: ChatTurn['answer'] | null;
    error: string | null;
}
export interface ChatResolvedAgent {
    snapshot: ChatAgentSnapshot;
    model: IModel;
}
export interface ChatParticipantsInput {
    expectedRevision: number;
    agentIds: string[];
}
export interface ChatRoundBudget {
    summaries: number;
}
export const unknownGroupUsage = (): ChatUsage => ({
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    reported: false,
});
export const responseView = (row: ChatResponseRow): ChatAgentResponse => ({
    id: row.id,
    agentId: row.agent_id,
    name: row.snapshot.name,
    slug: row.snapshot.slug,
    version: row.snapshot.version,
    modelId: row.snapshot.modelId,
    modelName: row.snapshot.modelName,
    modelPin: row.snapshot.modelPin,
    executionState: row.status === 'pending' ? (row.execution_state ?? 'waiting') : null,
    status: row.status,
    processingStage: row.processing_stage,
    ...(row.answer ? { answer: row.answer } : {}),
    ...(row.error ? { error: row.error } : {}),
});
