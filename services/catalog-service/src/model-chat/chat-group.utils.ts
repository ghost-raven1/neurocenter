import type { IChatUsage } from './chat.interfaces';
import type { IChatAgentResponse, IChatResponseRow } from './chat-group.interfaces';

export const unknownGroupUsage = (): IChatUsage => ({
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    reported: false,
});

export const responseView = (row: IChatResponseRow): IChatAgentResponse => ({
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
