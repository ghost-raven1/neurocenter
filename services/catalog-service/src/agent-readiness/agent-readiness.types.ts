export type AgentTrialStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type AgentTrialTool = 'none' | 'project_search';
export interface AgentTrialCheck {
    kind: 'prompt_sent' | 'model_response' | 'project_search';
    status: 'passed' | 'failed' | 'not_run';
    message: string;
}
/** This receipt describes a diagnostic server-chat call, never native OpenCode execution or general quality. */
export interface AgentTrialReceipt {
    agentVersion: number;
    agentManifest: string;
    agentPin: string;
    promptSha256: string;
    configSha256: string;
    modelId: string;
    modelName: string;
    modelPin: string;
    toolMode: AgentTrialTool;
    checks: AgentTrialCheck[];
    usage?: { calls: number; inputTokens: number | null; outputTokens: number | null; reported: boolean };
}
export interface AgentTrial {
    id: string;
    requestId: string;
    revision: number;
    executionSurface: 'server_chat';
    status: AgentTrialStatus;
    message: string;
    createdAt: string;
    finishedAt: string | null;
    current: boolean;
    staleReason?: string;
    canCancel: boolean;
    receipt: AgentTrialReceipt;
}
export interface AgentTrialEligibility {
    canRun: boolean;
    reason?: string;
    modelSelection: 'fixed' | 'choose';
    resolvedModelId?: string;
    models: Array<{ id: string; name: string; pin: string; available: boolean; reason?: string }>;
    tools: Array<{ kind: 'project_search'; available: boolean; requiresConsent: boolean; reason?: string }>;
}
export interface AgentTrialOverview {
    executionSurface: 'server_chat';
    items: Array<{
        agentId: string;
        currentPin: string;
        projectRevision: number;
        eligibility: AgentTrialEligibility;
        latestTrial: AgentTrial | null;
    }>;
}
export interface StartAgentTrial {
    requestId: string;
    expectedRevision: number;
    expectedAgentPin: string;
    modelId: string;
    expectedModelPin: string;
    tool: AgentTrialTool;
    toolConsent?: boolean;
}
