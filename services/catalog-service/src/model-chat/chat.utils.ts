import { responseView } from './chat-group.utils';
import type {
    IChatConversation,
    IChatTurn,
    IChatAttachment,
    IConversationRow,
    ITurnRow,
    IAttachmentRow,
} from './chat.interfaces';

export const conversationView = (row: IConversationRow): IChatConversation => ({
    id: row.id,
    modelId: row.model_id,
    projectId: row.project_id,
    title: row.title,
    mode: row.mode,
    modelPin: row.model_pin,
    revision: row.revision,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
});

export const turnView = (row: ITurnRow): IChatTurn => ({
    id: row.id,
    requestId: row.request_id,
    prompt: row.prompt,
    attachmentIds: row.attachment_ids,
    processingStage: row.processing_stage,
    executionState: row.status === 'pending' ? (row.execution_state ?? 'waiting') : null,
    status: row.status,
    ...(row.text_context ? { textContext: row.text_context } : {}),
    ...(row.agent_tools_request ? { agentTools: row.agent_tools_request } : {}),
    ...(row.research_request ? { research: row.research_request } : {}),
    ...(row.target_agent_ids?.length
        ? { targetAgentIds: row.target_agent_ids, responses: (row.responses ?? []).map(responseView) }
        : row.answer
          ? { answer: row.answer }
          : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: new Date(row.created_at).toISOString(),
});

export const attachmentView = (row: IAttachmentRow): IChatAttachment => ({
    id: row.id,
    name: row.name,
    mediaType: row.media_type,
    bytes: row.bytes,
    textBytes: row.text_bytes,
    ...(row.pages === null ? {} : { pages: row.pages }),
    ...(row.warning ? { warning: row.warning } : {}),
    createdAt: new Date(row.created_at).toISOString(),
});
