export interface ChatResearchRequest {
    project: boolean;
    external?: { assetId: string; version: number; manifest: string };
}
export type ChatResearchStepKind = 'planner' | 'project_search' | 'project_read' | 'external_search' | 'external_fetch';
export type ChatResearchStepStatus = 'pending' | 'done' | 'failed' | 'cancelled';
export interface ChatResearchStepSummary {
    id: string;
    conversationId: string;
    turnId: string;
    responseId: string | null;
    requestId: string;
    attempt: number;
    sequence: number;
    kind: ChatResearchStepKind;
    status: ChatResearchStepStatus;
    error: string | null;
    outputBytes: number;
    createdAt: string;
    updatedAt: string;
}
export interface ChatResearchStep extends ChatResearchStepSummary {
    input: Record<string, unknown>;
    output: string;
    sources: unknown[];
}
export interface ChatResearchHistory {
    items: ChatResearchStepSummary[];
    history: { hasMore: boolean; nextCursor: string | null };
}
export interface StartResearchStep {
    conversationId: string;
    turnId: string;
    responseId?: string | null;
    requestId: string;
    sequence: number;
    kind: ChatResearchStepKind;
    input: Record<string, unknown>;
}
export interface FinishResearchStep {
    id: string;
    requestId: string;
    status: Exclude<ChatResearchStepStatus, 'pending'>;
    output?: string;
    sources?: unknown[];
    error?: string | null;
}
