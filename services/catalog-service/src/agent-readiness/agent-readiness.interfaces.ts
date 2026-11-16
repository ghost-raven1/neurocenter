export type TAgentTrialStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type TAgentTrialTool = 'none' | 'project_search';
/** server_chat = model-inference diagnostic; opencode = contentful probe in the OpenCode environment (FR-307). */
export type TAgentTrialSurface = 'server_chat' | 'opencode';
export interface IAgentTrialCheck {
    kind: 'prompt_sent' | 'model_response' | 'project_search' | 'opencode_probe';
    status: 'passed' | 'failed' | 'not_run';
    message: string;
}
/**
 * A diagnostic receipt. server_chat describes a model-inference call; opencode describes a contentful
 * probe that actually executed in the OpenCode environment (never a bare card). Model identity is null
 * on the opencode surface because the probe does not route through a project chat model.
 */
export interface IAgentTrialReceipt {
    agentVersion: number;
    agentManifest: string;
    agentPin: string;
    promptSha256: string;
    configSha256: string;
    modelId: string | null;
    modelName: string | null;
    modelPin: string | null;
    toolMode: TAgentTrialTool;
    executionSurface: TAgentTrialSurface;
    checks: IAgentTrialCheck[];
    usage?: { calls: number; inputTokens: number | null; outputTokens: number | null; reported: boolean };
}
export interface IAgentTrial {
    id: string;
    requestId: string;
    revision: number;
    executionSurface: TAgentTrialSurface;
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
    /** opencode-surface readiness: available only when a contentful probe runtime is wired in. */
    opencode: { available: boolean; reason?: string };
}
export interface IAgentTrialOverview {
    executionSurface: TAgentTrialSurface;
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
    /** Omitted for legacy clients (treated as server_chat) and for the opencode surface (no model). */
    modelId?: string;
    expectedModelPin?: string;
    tool: TAgentTrialTool;
    toolConsent?: boolean;
    /** Default 'server_chat' for backward compatibility; 'opencode' selects the contentful probe. */
    executionSurface?: TAgentTrialSurface;
}
