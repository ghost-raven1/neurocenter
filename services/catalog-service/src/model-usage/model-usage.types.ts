import type { IModel } from '../models/model.types';
import type { ModelUsageContext, ModelUsagePurpose } from './model-usage.context';

export const MODEL_USAGE_STATUSES = ['pending', 'success', 'error', 'cancelled', 'interrupted'] as const;
export type ModelUsageStatus = typeof MODEL_USAGE_STATUSES[number];
export interface ModelUsageItem {
    id: string; modelId: string; modelName: string; provider: string; endpoint: 'chat' | 'embed'; purpose: ModelUsagePurpose;
    actorEmail: string | null; projectId: string | null; agentId: string | null; turnId: string | null; operationId: string | null;
    status: ModelUsageStatus; startedAt: string; finishedAt: string | null; latencyMs: number | null; inputTokens: number | null; outputTokens: number | null;
}
export interface ModelUsageTotals {
    requests: number; success: number; error: number; cancelled: number; interrupted: number; pending: number;
    inputTokens: string | null; outputTokens: string | null; knownInputRequests: number; knownOutputRequests: number; unknownInputRequests: number; unknownOutputRequests: number; averageLatencyMs: number | null;
}
export interface ModelUsageResult {
    window: { days: number; from: string; to: string }; summary: ModelUsageTotals;
    byModel: Array<ModelUsageTotals & { modelId: string; name: string }>;
    byPurpose: Array<ModelUsageTotals & { purpose: ModelUsagePurpose }>;
    items: ModelUsageItem[]; history: { hasMore: boolean; nextCursor: string | null };
}
export interface ModelUsageQuery { days?: string; projectId?: string; modelId?: string; purpose?: string; status?: string; cursor?: string; limit?: string }
export interface ModelUsageRecorder {
    observe(model: IModel, endpoint: 'chat' | 'embed', action: (signal: AbortSignal) => Promise<Record<string, unknown>>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
export interface UsageScope { all: boolean; actor: string | null; projectIds: string[] }
export interface UsageFilter { days: number; projectId?: string; modelId?: string; purpose?: ModelUsagePurpose; status?: ModelUsageStatus; cursor?: { startedAt: string; id: string }; limit: number }
export interface UsageTerminal { status: 'success' | 'error' | 'cancelled'; inputTokens: number | null; outputTokens: number | null; latencyMs: number }
export interface UsageInsert extends ModelUsageContext { id: string; workerId: string; model: IModel; endpoint: 'chat' | 'embed' }
