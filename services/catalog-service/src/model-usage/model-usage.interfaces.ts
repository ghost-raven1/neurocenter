import type { IModel } from '../models/model.interfaces';
import type { IModelUsageContext, TModelUsagePurpose } from './model-usage.context';
import type { MODEL_USAGE_STATUSES } from './model-usage.constants';

export type TModelUsageStatus = (typeof MODEL_USAGE_STATUSES)[number];

export interface IModelUsageItem {
    id: string;
    modelId: string;
    modelName: string;
    provider: string;
    endpoint: 'chat' | 'embed';
    purpose: TModelUsagePurpose;
    actorEmail: string | null;
    projectId: string | null;
    agentId: string | null;
    turnId: string | null;
    operationId: string | null;
    status: TModelUsageStatus;
    startedAt: string;
    finishedAt: string | null;
    latencyMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    actorName?: string | null;
    projectName?: string | null;
    agentName?: string | null;
    dispatchCount?: number | null;
    dispatchedAt?: string | null;
    rateWaitMs?: number | null;
    providerLatencyMs?: number | null;
    failureCode?: string | null;
}

export interface IModelUsageTotals {
    requests: number;
    success: number;
    error: number;
    cancelled: number;
    interrupted: number;
    pending: number;
    inputTokens: string | null;
    outputTokens: string | null;
    knownInputRequests: number;
    knownOutputRequests: number;
    unknownInputRequests: number;
    unknownOutputRequests: number;
    averageLatencyMs: number | null;
    apiCalls?: string | null;
    knownDispatchRequests?: number;
    unknownDispatchRequests?: number;
    rateWaitMs?: string | null;
    averageProviderLatencyMs?: number | null;
}

export interface IModelUsageResult {
    window: { days: number; from: string; to: string };
    summary: IModelUsageTotals;
    byModel: Array<IModelUsageTotals & { modelId: string; name: string }>;
    byPurpose: Array<IModelUsageTotals & { purpose: TModelUsagePurpose }>;
    items: IModelUsageItem[];
    history: { hasMore: boolean; nextCursor: string | null };
    scope?: { kind: 'all' | 'projects' | 'self'; actorEmail: string | null; projectIds: string[] };
    facets?: {
        users: Array<{ email: string | null; displayName: string }>;
        projects: Array<{ id: string; name: string }>;
        models: Array<{ id: string; name: string }>;
        agents: Array<{ id: string; name: string }>;
        providers: string[];
    };
    byActor?: Array<IModelUsageTotals & { actorEmail: string | null; displayName: string }>;
    byProject?: Array<IModelUsageTotals & { projectId: string | null; projectName: string }>;
    byEndpoint?: Array<IModelUsageTotals & { endpoint: 'chat' | 'embed' }>;
    byAgent?: Array<IModelUsageTotals & { agentId: string | null; agentName: string }>;
    series?: Array<IModelUsageTotals & { periodStart: string }>;
}

export interface IModelUsageQuery {
    days?: string;
    projectId?: string;
    modelId?: string;
    purpose?: string;
    status?: string;
    cursor?: string;
    limit?: string;
    actorEmail?: string;
    agentId?: string;
    endpoint?: string;
    provider?: string;
}

export interface IModelUsageRecorder {
    observe(
        model: IModel,
        endpoint: 'chat' | 'embed',
        action: (signal: AbortSignal) => Promise<Record<string, unknown>>,
        signal?: AbortSignal,
    ): Promise<Record<string, unknown>>;
}

export interface IUsageScope {
    all: boolean;
    actor: string | null;
    projectIds: string[];
    viewerEmail: string;
}

/** Internal report authorization refs; never included in the public usage response. */
export interface IUsagePrivateRoom {
    projectId: string;
    roomId: string;
}

export interface IUsageFilter {
    days: number;
    projectId?: string;
    modelId?: string;
    purpose?: TModelUsagePurpose;
    status?: TModelUsageStatus;
    cursor?: { startedAt: string; id: string };
    limit: number;
    actorEmail?: string | null;
    agentId?: string;
    endpoint?: 'chat' | 'embed';
    provider?: string;
}

export interface IUsageTerminal {
    quotaTracked?: boolean;
    status: 'success' | 'error' | 'cancelled';
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
    dispatchCount?: number | null;
    dispatchedAt?: string | null;
    rateWaitMs?: number | null;
    providerLatencyMs?: number | null;
    failureCode?: string | null;
}

export interface IUsageInsert extends IModelUsageContext {
    id: string;
    workerId: string;
    model: IModel;
    endpoint: 'chat' | 'embed';
}
