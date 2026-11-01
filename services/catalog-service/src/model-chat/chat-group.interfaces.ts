import type { IAgentDefinition } from '../../../shared/project-agents.cjs';
import type { IModel } from '../models/model.interfaces';
import type { IChatTurn } from './chat.interfaces';

export interface IChatParticipant {
    agentId: string;
    name: string;
    slug: string;
    status: 'active' | 'disabled' | 'removed' | 'blocked';
    reason?: string;
    modelId?: string;
    modelName?: string;
}

export interface IChatAgentSnapshot {
    agentId: string;
    name: string;
    slug: string;
    version: number;
    manifest: string;
    definition: IAgentDefinition;
    modelId: string;
    modelName: string;
    modelPin: string;
    sha256: string;
}

export interface IChatAgentResponse {
    id: string;
    agentId: string;
    name: string;
    slug: string;
    version: number;
    modelId: string;
    modelName: string;
    modelPin: string;
    status: IChatTurn['status'];
    executionState?: IChatTurn['executionState'];
    processingStage: IChatTurn['processingStage'];
    answer?: NonNullable<IChatTurn['answer']>;
    error?: string;
}

export interface IChatResponseRow {
    execution_state?: IChatTurn['executionState'];
    id: string;
    conversation_id: string;
    turn_id: string;
    agent_id: string;
    snapshot: IChatAgentSnapshot;
    request_id: string;
    status: IChatTurn['status'];
    processing_stage: IChatTurn['processingStage'];
    answer: IChatTurn['answer'] | null;
    error: string | null;
}

export interface IChatResolvedAgent {
    snapshot: IChatAgentSnapshot;
    model: IModel;
}

export interface IChatParticipantsInput {
    expectedRevision: number;
    agentIds: string[];
}

export interface IChatRoundBudget {
    summaries: number;
}
