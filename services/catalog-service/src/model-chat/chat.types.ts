import type { IChatContext } from './chat-context';
import { responseView, type ChatAgentResponse, type ChatParticipant, type ChatResponseRow } from './chat-group.types';
import type { ChatProjectEvidence } from './chat-project-context.types';
import type { ChatResearchRequest, ChatResearchStepSummary } from './chat-research.types';
import type { ResearchExternalSource } from './chat-research-client';
import type { ChatLearningReceipt } from './chat-learning-context.types';

export interface ChatConversation {
    id: string; modelId: string; projectId: string | null; title: string; modelPin: string;
    revision: number; createdAt: string; updatedAt: string; mode: 'model' | 'group';
}
export interface ChatUsage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; reported: boolean }
export interface ChatTurn {
    id: string; requestId: string; prompt: string; attachmentIds: string[];
    status: 'pending' | 'done' | 'failed' | 'cancelled';
    processingStage: 'compacting' | 'responding' | 'researching';
    research?: ChatResearchRequest; researchSteps?: ChatResearchStepSummary[];
    answer?: { content: string; finishReason: 'stop' | 'length'; usage: ChatUsage; evidence?: ChatProjectEvidence; learning?: ChatLearningReceipt; researchSources?: ResearchExternalSource[]; researchLimited?: boolean };
    targetAgentIds?: string[]; responses?: ChatAgentResponse[];
    error?: string; createdAt: string;
}
export interface ChatAttachment { id: string; name: string; mediaType: string; bytes: number; textBytes: number; pages?: number; warning?: string; createdAt: string }
export interface ChatHistory { hasMore: boolean; nextCursor: string | null }
export interface ChatCompaction { state: 'none' | 'ready' | 'compacting'; coveredTurns: number; updatedAt?: string }
export interface ChatDetail { conversation: ChatConversation; turns: ChatTurn[]; attachments: ChatAttachment[]; context: IChatContext; blockedReason: string | null; history: ChatHistory; compaction: ChatCompaction; participants?: ChatParticipant[]; projectContext?: ChatProjectEvidence }
export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string }
export interface ChatCreateInput { modelId: string; projectId?: string; expectedModelPin: string; title?: string; mode?: 'model' | 'group'; agentIds?: string[] }
export interface ChatRevisionInput { expectedRevision: number }
export interface ChatRenameInput extends ChatRevisionInput { title: string }
export interface ChatUploadInput { name: string; contentBase64: string; requestId: string }
export interface ChatSendInput extends ChatRevisionInput { requestId: string; expectedModelPin: string; prompt: string; attachmentIds: string[]; targetAgentIds?: string[]; research?: ChatResearchRequest }
export interface ChatRetryInput extends ChatRevisionInput { requestId: string; expectedModelPin: string }
export interface ChatPreviewInput { prompt: string; attachmentIds: string[]; targetAgentIds?: string[] }
export interface ConversationRow {
    id: string; owner_email: string; model_id: string; project_id: string | null; title: string; model_pin: string;
    revision: number; created_at: Date | string; updated_at: Date | string; mode: 'model' | 'group'; agent_ids: string[];
}
export interface TurnRow {
    position: number | string; processing_stage: ChatTurn['processingStage']; research_request?: ChatResearchRequest | null;
    id: string; conversation_id: string; request_id: string; request_ids: string[]; request_hash: string;
    prompt: string; attachment_ids: string[]; input_text: string; status: ChatTurn['status'];
    answer: ChatTurn['answer'] | null; error: string | null; created_at: Date | string;
    lease_until: Date | string | null; removed_at: Date | string | null; target_agent_ids: string[]; responses?: ChatResponseRow[];
}
export interface AttachmentRow {
    id: string; conversation_id: string; request_id: string; request_hash: string; name: string; media_type: string;
    bytes: number; object_id: string | null; storage_state: 'S3' | 'TRANSFER' | 'DELETED'; text: string; text_bytes: number; pages: number | null; warning: string | null;
    created_at: Date | string; deleted_at: Date | string | null;
}
export const conversationView = (row: ConversationRow): ChatConversation => ({ id: row.id, modelId: row.model_id, projectId: row.project_id, title: row.title, mode: row.mode,
    modelPin: row.model_pin, revision: row.revision, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() });
export const turnView = (row: TurnRow): ChatTurn => ({ id: row.id, requestId: row.request_id, prompt: row.prompt, attachmentIds: row.attachment_ids, processingStage: row.processing_stage,
    status: row.status, ...(row.research_request ? { research: row.research_request } : {}), ...(row.target_agent_ids?.length ? { targetAgentIds: row.target_agent_ids, responses: (row.responses ?? []).map(responseView) } : row.answer ? { answer: row.answer } : {}), ...(row.error ? { error: row.error } : {}), createdAt: new Date(row.created_at).toISOString() });
export const attachmentView = (row: AttachmentRow): ChatAttachment => ({ id: row.id, name: row.name, mediaType: row.media_type, bytes: row.bytes, textBytes: row.text_bytes,
    ...(row.pages === null ? {} : { pages: row.pages }), ...(row.warning ? { warning: row.warning } : {}), createdAt: new Date(row.created_at).toISOString() });
