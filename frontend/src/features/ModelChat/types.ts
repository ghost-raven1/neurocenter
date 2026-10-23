import type { ICatalogModel } from '../ModelCatalog/types';
import type { ReactNode } from 'react';

export interface IModelChatUsage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; reported: boolean; }
export interface IChatProjectSource { id: string; path: string; title?: string; startLine?: number; endLine?: number; score: number; excerpt: string; }
export interface IChatProjectEvidence {
    status: 'none' | 'metadata' | 'ready' | 'empty' | 'unavailable';
    project?: {id: string; name: string; state: string; headRevision: number}; generation?: string; sources: IChatProjectSource[]; message?: string;
}
export interface IModelChatAnswer { content: string; finishReason: 'stop' | 'length'; usage?: IModelChatUsage; evidence?: IChatProjectEvidence; researchSources?: Array<{url: string; title?: string}>; researchLimited?: boolean; }
export interface IModelChatParticipant { agentId: string; name: string; slug: string; status: 'active' | 'disabled' | 'removed' | 'blocked'; reason?: string; modelId?: string; modelName?: string; }
export interface IModelChatResponse { id: string; agentId: string; name: string; slug: string; version: number; status: 'pending' | 'done' | 'failed' | 'cancelled'; executionState?: 'waiting' | 'running' | null; processingStage?: 'compacting' | 'responding' | 'researching'; modelId: string; modelName: string; modelPin: string; answer?: IModelChatAnswer; error?: string; }
export interface IModelChatTurn {
    id: string; requestId: string; prompt: string; attachmentIds: string[];
    status: 'pending' | 'done' | 'failed' | 'cancelled'; answer?: IModelChatAnswer; error?: string; createdAt: string;
    executionState?: 'waiting' | 'running' | null;
    processingStage?: 'compacting' | 'responding' | 'researching';
    targetAgentIds?: string[]; responses?: IModelChatResponse[]; research?: IChatResearchRequest; researchSteps?: IChatResearchStepSummary[];
}
export interface IModelChatConversation {
    id: string; modelId: string; projectId: string | null; title: string; modelPin: string;
    revision: number; createdAt: string; updatedAt: string;
    mode?: 'model' | 'group';
}
export interface IModelChatAttachment { id: string; name: string; mediaType: string; bytes: number; textBytes: number; pages?: number; warning?: string; createdAt: string; }
export interface IModelChatContext {
    contextWindowTokens: number | null; reservedOutputTokens: number | null; estimatedInputTokens: number;
    method: 'estimate'; messageCount: number; maxMessageBytes: number; maxRequestBytes: number;
    requestBytes: number; exceeded: boolean; canCompact: boolean; compactionNeeded: boolean; reason?: string;
    participants?: Array<{agentId: string; name: string; modelId: string; modelName: string; context: Omit<IModelChatContext, 'participants'>}>;
}
export interface IModelChatHistory { hasMore: boolean; nextCursor: string | null; }
export interface IModelChatCompaction { state: 'none' | 'ready' | 'compacting'; coveredTurns: number; updatedAt?: string; }
export interface IModelChatHistoryPage { turns: IModelChatTurn[]; attachments: IModelChatAttachment[]; history: IModelChatHistory; }
export interface IModelChatDetail extends IModelChatHistoryPage { conversation: IModelChatConversation; context: IModelChatContext; compaction: IModelChatCompaction; blockedReason?: string | null; projectContext?: IChatProjectEvidence; participants?: IModelChatParticipant[]; }
export interface IModelChatAttachmentPreview { attachment: IModelChatAttachment; text: string; }
export interface IChatUpload { id: string; name: string; bytes: number; state: 'uploading' | 'failed'; error?: string; file: File; }
export interface IModelChatProps { model: ICatalogModel; projectId?: string; projectName?: string; unavailableReason?: string; onClose: () => void; }
export interface IChatWorkspaceNavigation {
    items: IModelChatConversation[]; loading: boolean; opening?: boolean; error?: string; initialDetail?: IModelChatDetail; initialGroup?: boolean;
    controls: (request: (action: () => void) => void) => ReactNode;
    onSelect: (conversation: IModelChatConversation) => void; onRefresh: () => void;
    onChanged: (conversation: IModelChatConversation | null) => void;
}

export interface IChatResearchRequest {project: boolean; external?: {assetId: string; version: number; manifest: string};}
export interface IChatResearchChoice {assetId: string; name: string; version: number; manifest: string; available: boolean; reason?: string;}
export interface IChatResearchChoices {project: {available: boolean; reason?: string}; external: IChatResearchChoice[]; limits: {stepsPerRecipient: number; externalCallsPerRound: number; toolOutputBytes: number; gatheredTextBytes: number; roundTimeoutMs: number};}
export interface IChatResearchStepSummary {id: string; conversationId: string; turnId: string; responseId: string | null; requestId: string; attempt: number; sequence: number; kind: 'planner' | 'project_search' | 'project_read' | 'external_search' | 'external_fetch'; status: 'pending' | 'done' | 'failed' | 'cancelled'; error: string | null; outputBytes: number; createdAt: string; updatedAt: string;}
export interface IChatResearchStep extends IChatResearchStepSummary {input: Record<string, unknown>; output: string; sources: unknown[];}

export interface IChatResearchHistory {items: IChatResearchStepSummary[]; history: IModelChatHistory;}
