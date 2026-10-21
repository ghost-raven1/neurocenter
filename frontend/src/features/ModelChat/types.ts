import type { ICatalogModel } from '../ModelCatalog/types';

export interface IModelChatUsage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; reported: boolean; }
export interface IModelChatAnswer { content: string; finishReason: 'stop' | 'length'; usage?: IModelChatUsage; }
export interface IModelChatTurn {
    id: string; requestId: string; prompt: string; attachmentIds: string[];
    status: 'pending' | 'done' | 'failed' | 'cancelled'; answer?: IModelChatAnswer; error?: string; createdAt: string;
}
export interface IModelChatConversation {
    id: string; modelId: string; projectId: string | null; title: string; modelPin: string;
    revision: number; createdAt: string; updatedAt: string;
}
export interface IModelChatAttachment { id: string; name: string; mediaType: string; bytes: number; textBytes: number; pages?: number; warning?: string; createdAt: string; }
export interface IModelChatContext {
    contextWindowTokens: number | null; reservedOutputTokens: number | null; estimatedInputTokens: number;
    method: 'estimate'; messageCount: number; maxMessages: number; maxMessageBytes: number; maxRequestBytes: number;
    requestBytes: number; exceeded: boolean; reason?: string;
}
export interface IModelChatDetail { conversation: IModelChatConversation; turns: IModelChatTurn[]; attachments: IModelChatAttachment[]; context: IModelChatContext; blockedReason?: string | null; }
export interface IModelChatAttachmentPreview { attachment: IModelChatAttachment; text: string; }
export interface IChatUpload { id: string; name: string; bytes: number; state: 'uploading' | 'failed'; error?: string; file: File; }
export interface IModelChatProps { model: ICatalogModel; projectId?: string; projectName?: string; unavailableReason?: string; onClose: () => void; }
