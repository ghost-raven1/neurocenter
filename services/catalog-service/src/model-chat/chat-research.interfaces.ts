export interface IChatResearchRequest {
    project: boolean;
    external?: { assetId: string; version: number; manifest: string };
}
export type TChatResearchStepKind =
    'planner' | 'project_search' | 'project_read' | 'external_search' | 'external_fetch';
export type TChatResearchStepStatus = 'pending' | 'done' | 'failed' | 'cancelled';
export interface IChatResearchStepSummary {
    id: string;
    conversationId: string;
    turnId: string;
    responseId: string | null;
    requestId: string;
    attempt: number;
    sequence: number;
    kind: TChatResearchStepKind;
    status: TChatResearchStepStatus;
    error: string | null;
    outputBytes: number;
    createdAt: string;
    updatedAt: string;
}
export interface IChatResearchStep extends IChatResearchStepSummary {
    input: Record<string, unknown>;
    output: string;
    sources: unknown[];
}
export interface IChatResearchHistory {
    items: IChatResearchStepSummary[];
    history: { hasMore: boolean; nextCursor: string | null };
}
export interface IStartResearchStep {
    conversationId: string;
    turnId: string;
    responseId?: string | null;
    requestId: string;
    sequence: number;
    kind: TChatResearchStepKind;
    input: Record<string, unknown>;
}
export interface IFinishResearchStep {
    id: string;
    requestId: string;
    status: Exclude<TChatResearchStepStatus, 'pending'>;
    output?: string;
    sources?: unknown[];
    error?: string | null;
}
