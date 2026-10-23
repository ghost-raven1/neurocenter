export type UsageStatus = 'pending' | 'success' | 'error' | 'cancelled' | 'interrupted';
export type UsagePurpose = 'chat' | 'agent' | 'compaction' | 'project-search' | 'device-embedding' | 'reindex' | 'learning' | 'direct' | 'verification' | 'research';
export interface UsageTotals {
    requests: number; success: number; error: number; cancelled: number; interrupted: number; pending: number;
    inputTokens: string | null; outputTokens: string | null; knownInputRequests: number; knownOutputRequests: number;
    unknownInputRequests: number; unknownOutputRequests: number; averageLatencyMs: number | null;
    apiCalls: string | null; knownDispatchRequests: number; unknownDispatchRequests: number;
    rateWaitMs: string | null; averageProviderLatencyMs: number | null;
}
export interface UsageItem {
    id: string; modelId: string; modelName: string; provider: string; endpoint: 'chat' | 'embed'; purpose: UsagePurpose;
    actorEmail: string | null; actorName: string | null; projectId: string | null; projectName: string | null; agentId: string | null; agentName: string | null;
    turnId: string | null; operationId: string | null; status: UsageStatus; startedAt: string; finishedAt: string | null;
    latencyMs: number | null; inputTokens: number | null; outputTokens: number | null;
    dispatchCount: number | null; rateWaitMs: number | null; providerLatencyMs: number | null; dispatchedAt: string | null; failureCode: string | null;
}
export interface UsageFacets {
    users: Array<{email: string | null; displayName: string}>; projects: Array<{id: string; name: string}>;
    models: Array<{id: string; name: string}>; agents: Array<{id: string; name: string}>; providers: string[];
}
export interface UsageReport {
    window: {days: number; from: string; to: string}; summary: UsageTotals;
    scope: {kind: 'all' | 'projects' | 'self'; actorEmail: string | null; projectIds: string[]}; facets: UsageFacets;
    byModel: Array<UsageTotals & {modelId: string; name: string}>; byPurpose: Array<UsageTotals & {purpose: UsagePurpose}>;
    byActor: Array<UsageTotals & {actorEmail: string | null; displayName: string}>;
    byProject: Array<UsageTotals & {projectId: string | null; projectName: string | null}>;
    byEndpoint: Array<UsageTotals & {endpoint: 'chat' | 'embed'}>; byAgent: Array<UsageTotals & {agentId: string | null; agentName: string | null}>;
    series: Array<UsageTotals & {periodStart: string}>; items: UsageItem[]; history: {hasMore: boolean; nextCursor: string | null};
}
export interface UsageFilters {
    days: 1 | 7 | 30; projectId?: string; actorEmail?: string; modelId?: string; agentId?: string;
    purpose?: UsagePurpose; status?: UsageStatus; endpoint?: 'chat' | 'embed'; provider?: string;
}
