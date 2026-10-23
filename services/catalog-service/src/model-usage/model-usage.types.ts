import type { IModel } from '../models/model.types';
import type { ModelUsageContext, ModelUsagePurpose } from './model-usage.context';

export const MODEL_USAGE_STATUSES = ['pending', 'success', 'error', 'cancelled', 'interrupted'] as const;
export type ModelUsageStatus = typeof MODEL_USAGE_STATUSES[number];
export interface ModelUsageItem {
    id: string; modelId: string; modelName: string; provider: string; endpoint: 'chat' | 'embed'; purpose: ModelUsagePurpose;
    actorEmail: string | null; projectId: string | null; agentId: string | null; turnId: string | null; operationId: string | null;
    status: ModelUsageStatus; startedAt: string; finishedAt: string | null; latencyMs: number | null; inputTokens: number | null; outputTokens: number | null;
    actorName?: string | null; projectName?: string | null; agentName?: string | null;
    dispatchCount?: number | null; dispatchedAt?: string | null; rateWaitMs?: number | null; providerLatencyMs?: number | null; failureCode?: string | null;
}
export interface ModelUsageTotals {
    requests: number; success: number; error: number; cancelled: number; interrupted: number; pending: number;
    inputTokens: string | null; outputTokens: string | null; knownInputRequests: number; knownOutputRequests: number; unknownInputRequests: number; unknownOutputRequests: number; averageLatencyMs: number | null;
    apiCalls?: string | null; knownDispatchRequests?: number; unknownDispatchRequests?: number; rateWaitMs?: string | null; averageProviderLatencyMs?: number | null;
}
export interface ModelUsageResult {
    window: { days: number; from: string; to: string }; summary: ModelUsageTotals;
    byModel: Array<ModelUsageTotals & { modelId: string; name: string }>;
    byPurpose: Array<ModelUsageTotals & { purpose: ModelUsagePurpose }>;
    items: ModelUsageItem[]; history: { hasMore: boolean; nextCursor: string | null };
    scope?: { kind: 'all' | 'projects' | 'self'; actorEmail: string | null; projectIds: string[] };
    facets?: { users: Array<{ email: string | null; displayName: string }>; projects: Array<{ id: string; name: string }>;
        models: Array<{ id: string; name: string }>; agents: Array<{ id: string; name: string }>; providers: string[] };
    byActor?: Array<ModelUsageTotals & { actorEmail: string | null; displayName: string }>;
    byProject?: Array<ModelUsageTotals & { projectId: string | null; projectName: string }>;
    byEndpoint?: Array<ModelUsageTotals & { endpoint: 'chat' | 'embed' }>;
    byAgent?: Array<ModelUsageTotals & { agentId: string | null; agentName: string }>;
    series?: Array<ModelUsageTotals & { periodStart: string }>;
}
export interface ModelUsageQuery { days?: string; projectId?: string; modelId?: string; purpose?: string; status?: string; cursor?: string; limit?: string; actorEmail?: string; agentId?: string; endpoint?: string; provider?: string }
export interface ModelUsageRecorder {
    observe(model: IModel, endpoint: 'chat' | 'embed', action: (signal: AbortSignal) => Promise<Record<string, unknown>>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
export interface UsageScope { all: boolean; actor: string | null; projectIds: string[] }
export interface UsageFilter { days: number; projectId?: string; modelId?: string; purpose?: ModelUsagePurpose; status?: ModelUsageStatus; cursor?: { startedAt: string; id: string }; limit: number;
    actorEmail?: string | null; agentId?: string; endpoint?: 'chat' | 'embed'; provider?: string }
export interface UsageTerminal { status: 'success' | 'error' | 'cancelled'; inputTokens: number | null; outputTokens: number | null; latencyMs: number;
    dispatchCount?: number | null; dispatchedAt?: string | null; rateWaitMs?: number | null; providerLatencyMs?: number | null; failureCode?: string | null }
export interface UsageInsert extends ModelUsageContext { id: string; workerId: string; model: IModel; endpoint: 'chat' | 'embed' }
