import type { IAgentToolGrant } from '../agent-tools/agent-tools.interfaces';
import type { ITextContext } from '../../../shared/project-text-knowledge.cjs';
import type { IChatContext } from './chat-context';
import { type IChatAgentResponse, type IChatParticipant, type IChatResponseRow } from './chat-group.interfaces';
import type { IChatProjectEvidence } from './chat-project-context.interfaces';
import type { IChatResearchRequest, IChatResearchStepSummary } from './chat-research.interfaces';
import type { IResearchExternalSource } from './chat-research-client';
import type { IChatLearningReceipt } from './chat-learning-context.interfaces';

export interface IChatConversation {
    id: string;
    modelId: string;
    projectId: string | null;
    title: string;
    modelPin: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    mode: 'model' | 'group';
}

export interface IChatUsage {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    reported: boolean;
}

export interface IChatTurn {
    id: string;
    requestId: string;
    prompt: string;
    attachmentIds: string[];
    status: 'pending' | 'done' | 'failed' | 'cancelled';
    executionState?: 'waiting' | 'running' | null;
    processingStage: 'compacting' | 'responding' | 'researching';
    agentTools?: IAgentToolGrant;
    research?: IChatResearchRequest;
    researchSteps?: IChatResearchStepSummary[];
    textContext?: { selection: ITextContext; evidence: IChatProjectEvidence };
    answer?: {
        content: string;
        finishReason: 'stop' | 'length';
        usage: IChatUsage;
        evidence?: IChatProjectEvidence;
        learning?: IChatLearningReceipt;
        researchSources?: IResearchExternalSource[];
        researchLimited?: boolean;
    };
    targetAgentIds?: string[];
    responses?: IChatAgentResponse[];
    discussion?: { mode: 'automatic'; callsStarted: number; maxCalls: number };
    error?: string;
    createdAt: string;
}

export interface IChatAttachment {
    id: string;
    name: string;
    mediaType: string;
    bytes: number;
    textBytes: number;
    pages?: number;
    warning?: string;
    createdAt: string;
}

export interface IChatHistory {
    hasMore: boolean;
    nextCursor: string | null;
}

export interface IChatCompaction {
    state: 'none' | 'ready' | 'compacting';
    coveredTurns: number;
    updatedAt?: string;
}

export interface IChatDetail {
    conversation: IChatConversation;
    turns: IChatTurn[];
    attachments: IChatAttachment[];
    context: IChatContext;
    blockedReason: string | null;
    history: IChatHistory;
    compaction: IChatCompaction;
    participants?: IChatParticipant[];
    projectContext?: IChatProjectEvidence;
}

export interface IChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface IChatCreateInput {
    modelId: string;
    projectId?: string;
    expectedModelPin: string;
    title?: string;
    mode?: 'model' | 'group';
    agentIds?: string[];
}

export interface IChatRevisionInput {
    expectedRevision: number;
}

export interface IChatRenameInput extends IChatRevisionInput {
    title: string;
}

export interface IChatUploadInput {
    name: string;
    contentBase64: string;
    requestId: string;
}

export interface IChatSendInput extends IChatRevisionInput {
    requestId: string;
    expectedModelPin: string;
    prompt: string;
    attachmentIds: string[];
    targetAgentIds?: string[];
    research?: IChatResearchRequest;
    agentTools?: IAgentToolGrant;
    textContext?: ITextContext;
}

export interface IChatRetryInput extends IChatRevisionInput {
    requestId: string;
    expectedModelPin: string;
}

export interface IChatPreviewInput {
    prompt: string;
    attachmentIds: string[];
    targetAgentIds?: string[];
}

export interface IConversationRow {
    id: string;
    owner_email: string;
    model_id: string;
    project_id: string | null;
    title: string;
    model_pin: string;
    revision: number;
    created_at: Date | string;
    updated_at: Date | string;
    mode: 'model' | 'group';
    agent_ids: string[];
}

export interface ITurnRow {
    text_context?: { selection: ITextContext; evidence: IChatProjectEvidence };
    execution_state?: IChatTurn['executionState'];
    position: number | string;
    processing_stage: IChatTurn['processingStage'];
    research_request?: IChatResearchRequest | null;
    agent_tools_request?: IAgentToolGrant | null;
    id: string;
    conversation_id: string;
    request_id: string;
    request_ids: string[];
    request_hash: string;
    prompt: string;
    attachment_ids: string[];
    input_text: string;
    status: IChatTurn['status'];
    answer: IChatTurn['answer'] | null;
    error: string | null;
    created_at: Date | string;
    lease_until: Date | string | null;
    removed_at: Date | string | null;
    target_agent_ids: string[];
    responses?: IChatResponseRow[];
}

export interface IAttachmentRow {
    id: string;
    conversation_id: string;
    request_id: string;
    request_hash: string;
    name: string;
    media_type: string;
    bytes: number;
    object_id: string | null;
    storage_state: 'S3' | 'TRANSFER' | 'DELETED';
    text: string;
    text_bytes: number;
    pages: number | null;
    warning: string | null;
    created_at: Date | string;
    deleted_at: Date | string | null;
}
