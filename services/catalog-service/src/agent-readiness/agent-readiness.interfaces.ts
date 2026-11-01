export type TAgentTrialStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type TAgentTrialTool = 'none' | 'project_search';
export interface IAgentTrialCheck {
    kind: 'prompt_sent' | 'model_response' | 'project_search';
    status: 'passed' | 'failed' | 'not_run';
    message: string;
}
/** This receipt describes a diagnostic server-chat call, never native OpenCode execution or general quality. */
export interface IAgentTrialReceipt {
    agentVersion: number;
    agentManifest: string;
    agentPin: string;
    promptSha256: string;
    configSha256: string;
    modelId: string;
    modelName: string;
    modelPin: string;
    toolMode: TAgentTrialTool;
    checks: IAgentTrialCheck[];
    usage?: { calls: number; inputTokens: number | null; outputTokens: number | null; reported: boolean };
}
export interface IAgentTrial {
    id: string;
    requestId: string;
    revision: number;
    executionSurface: 'server_chat';
    status: TAgentTrialStatus;
    message: string;
    createdAt: string;
    finishedAt: string | null;
    current: boolean;
    staleReason?: string;
    canCancel: boolean;
    receipt: IAgentTrialReceipt;
}
export interface IAgentTrialEligibility {
    canRun: boolean;
    reason?: string;
    modelSelection: 'fixed' | 'choose';
    resolvedModelId?: string;
    models: Array<{ id: string; name: string; pin: string; available: boolean; reason?: string }>;
    tools: Array<{ kind: 'project_search'; available: boolean; requiresConsent: boolean; reason?: string }>;
}
export interface IAgentTrialOverview {
    executionSurface: 'server_chat';
    items: Array<{
        agentId: string;
        currentPin: string;
        projectRevision: number;
        eligibility: IAgentTrialEligibility;
        latestTrial: IAgentTrial | null;
    }>;
}
export interface IStartAgentTrial {
    requestId: string;
    expectedRevision: number;
    expectedAgentPin: string;
    modelId: string;
    expectedModelPin: string;
    tool: TAgentTrialTool;
    toolConsent?: boolean;
}
