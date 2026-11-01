export type TUsageStatus = 'pending' | 'success' | 'error' | 'cancelled' | 'interrupted';
export type TUsagePurpose =
    | 'chat'
    | 'agent'
    | 'compaction'
    | 'project-search'
    | 'device-embedding'
    | 'reindex'
    | 'learning'
    | 'direct'
    | 'verification'
    | 'research';
export interface IUsageTotals {
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
    apiCalls: string | null;
    knownDispatchRequests: number;
    unknownDispatchRequests: number;
    rateWaitMs: string | null;
    averageProviderLatencyMs: number | null;
}
export interface IUsageItem {
    id: string;
    modelId: string;
    modelName: string;
    provider: string;
    endpoint: 'chat' | 'embed';
    purpose: TUsagePurpose;
    actorEmail: string | null;
    actorName: string | null;
    projectId: string | null;
    projectName: string | null;
    agentId: string | null;
    agentName: string | null;
    turnId: string | null;
    operationId: string | null;
    status: TUsageStatus;
    startedAt: string;
    finishedAt: string | null;
    latencyMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    dispatchCount: number | null;
    rateWaitMs: number | null;
    providerLatencyMs: number | null;
    dispatchedAt: string | null;
    failureCode: string | null;
}
export interface IUsageFacets {
    users: Array<{ email: string | null; displayName: string }>;
    projects: Array<{ id: string; name: string }>;
    models: Array<{ id: string; name: string }>;
    agents: Array<{ id: string; name: string }>;
    providers: string[];
}
export interface IUsageReport {
    window: { days: number; from: string; to: string };
    summary: IUsageTotals;
    scope: { kind: 'all' | 'projects' | 'self'; actorEmail: string | null; projectIds: string[] };
    facets: IUsageFacets;
    byModel: Array<IUsageTotals & { modelId: string; name: string }>;
    byPurpose: Array<IUsageTotals & { purpose: TUsagePurpose }>;
    byActor: Array<IUsageTotals & { actorEmail: string | null; displayName: string }>;
    byProject: Array<IUsageTotals & { projectId: string | null; projectName: string | null }>;
    byEndpoint: Array<IUsageTotals & { endpoint: 'chat' | 'embed' }>;
    byAgent: Array<IUsageTotals & { agentId: string | null; agentName: string | null }>;
    series: Array<IUsageTotals & { periodStart: string }>;
    items: IUsageItem[];
    history: { hasMore: boolean; nextCursor: string | null };
}
export interface IUsageFilters {
    days: 1 | 7 | 30;
    projectId?: string;
    actorEmail?: string;
    modelId?: string;
    agentId?: string;
    purpose?: TUsagePurpose;
    status?: TUsageStatus;
    endpoint?: 'chat' | 'embed';
    provider?: string;
}
