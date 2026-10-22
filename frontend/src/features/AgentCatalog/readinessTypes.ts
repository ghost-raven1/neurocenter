export type TAgentTrialStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type TAgentTrialTool = 'none' | 'project_search';
export interface IAgentTrialCheck {
    kind: 'prompt_sent' | 'model_response' | 'project_search';
    status: 'passed' | 'failed' | 'not_run'; message: string;
}
/** A diagnostic receipt applies to one server-chat configuration and model. */
export interface IAgentTrial {
    id: string; requestId: string; revision: number; executionSurface: 'server_chat'; status: TAgentTrialStatus;
    message: string; createdAt: string; finishedAt: string | null; current: boolean; staleReason?: string; canCancel: boolean;
    receipt: {
        agentVersion: number; agentManifest: string; agentPin: string; promptSha256: string; configSha256: string;
        modelId: string; modelName: string; modelPin: string; toolMode: TAgentTrialTool; checks: IAgentTrialCheck[];
        usage?: { calls: number; inputTokens: number | null; outputTokens: number | null; reported: boolean };
    };
}
export interface IAgentReadinessItem {
    agentId: string; currentPin: string; projectRevision: number;
    eligibility: {
        canRun: boolean; reason?: string; modelSelection: 'fixed' | 'choose'; resolvedModelId?: string;
        models: Array<{ id: string; name: string; pin: string; available: boolean; reason?: string }>;
        tools: Array<{ kind: 'project_search'; available: boolean; requiresConsent: boolean; reason?: string }>;
    };
    latestTrial: IAgentTrial | null;
}
export interface IAgentReadiness { executionSurface: 'server_chat'; items: IAgentReadinessItem[]; }
export interface IAgentTrialStart {
    requestId: string; expectedRevision: number; expectedAgentPin: string;
    modelId: string; expectedModelPin: string; tool: TAgentTrialTool; toolConsent?: boolean;
}
