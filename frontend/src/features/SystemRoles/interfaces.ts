export type TSystemRoleId =
    'agent-ai-admin' | 'agent-autoconfigurator' | 'agent-indexer' | 'agent-packager' | 'agent-coordinator';

export type TRoleFlag =
    'system_ai_admin' | 'system_autoconfigurator' | 'system_indexer' | 'tool_build_agent' | 'system_coordinator';

export type TTargetKind =
    'prompt' | 'agent' | 'skill' | 'plugin-settings' | 'adapter' | 'public-chat' | 'package-source' | 'dialog-context';

export type TDiagnosticKind = 'health' | 'project' | 'bridge' | 'containers' | 'index';

export interface IRoleDefinition {
    id: TSystemRoleId;
    name: string;
    flag: TRoleFlag;
    description: string;
    definitionPin: string;
    targets: TTargetKind[];
    diagnostics: TDiagnosticKind[];
}

export type TRoleMcpTarget = (
    | { runtime: 'server' }
    | {
          runtime: 'device';
          deviceId: string;
          bindingId: string;
          instanceId: string;
          configurationRevisions: Array<{ assetId: string; manifest: string; revision: string | null }>;
      }
) & { assetId: string; assetKind?: 'mcp' | 'plugin'; version: number; manifest: string };

export type TRoleMcpSelection = TRoleMcpTarget & {
    discoveryId: string;
    tools: Array<{ name: string; schemaDigest: string }>;
};

export interface IRoleMcpTool {
    name: string;
    description: string;
    schemaDigest: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
}

export interface IRoleSelection {
    projectId: string | null;
    instruction: string;
    diagnostics: TDiagnosticKind[];
    targets: Array<{ kind: TTargetKind; id: string; text?: string }>;
    mcp?: TRoleMcpSelection[];
}

/** Server-owned read grant; it is never part of a client selection or start request. */
export interface IRoleProjectContextGrant {
    scope: 'project-index';
    projectId: string;
    projectName: string;
    identity: string;
    recipients: TSystemRoleId[];
    generation?: string;
    snapshot?: string;
}

export interface IRoleProjectContextSource {
    id: string;
    path: string;
    title?: string;
    startLine?: number;
    endLine?: number;
}

export interface IRoleProjectContextReceipt {
    status: 'metadata' | 'ready' | 'empty' | 'unavailable';
    project: { id: string; name: string };
    generation?: string;
    snapshot?: string;
    sources: IRoleProjectContextSource[];
    message?: string;
}

export interface IRoleGuidanceEvidence {
    status: 'ready' | 'unavailable';
    checkedAt: string;
    sources: Array<{ id: string; kind: 'help' | 'diagnostic'; title: string; slug?: string; revision?: string }>;
    message?: string;
}

export interface IRolePrepared {
    guidance?: { version: 1; projectId: string | null };
    preview: string;
    consentDigest: string;
    definitionPin: string;
    targets: Array<{ key: string; kind: TTargetKind; id: string; version: number; editable: boolean }>;
    mcp?: Array<{ target: TRoleMcpSelection; tools: Array<IRoleMcpTool & { toolKey: string }> }>;
    projectContext?: IRoleProjectContextGrant;
}

export interface IRoleStart extends IRoleSelection {
    requestId: string;
    modelId: string;
    expectedModelPin: string;
    expectedDefinitionPin: string;
    consentDigest: string;
}

export interface IRoleOverview {
    definitions: IRoleDefinition[];
    budget: { calls: number; diagnostics: number; targets: number; deadlineMs: number };
    models: Array<{ id: string; name: string; pin: string }>;
    targets: Array<{ kind: TTargetKind; id: string; name: string }>;
    projectId: string | null;
}

export interface IRoleRun {
    id: string;
    agentId: TSystemRoleId;
    projectId: string | null;
    actor: string;
    state: string;
    phase: string;
    revision: number;
    operationId: string;
    message: string;
    createdAt: string;
    finishedAt: string | null;
    callsStarted: number;
    modelCallBudget?: number;
    modelId: string;
    modelPin: string;
    facts: Array<{
        id: string;
        kind: TDiagnosticKind;
        checkedAt: string;
        status: 'measured' | 'unavailable';
        data: Record<string, unknown>;
    }>;
    result: IRoleResult | null;
    steps: Array<{ at: string; phase: string; message: string }>;
    applied: Array<{ targetKey: string; version: number; pin: string; owner: string }>;
    targets: Array<{ key: string; kind: TTargetKind; id: string; version: number; content: string; editable: boolean }>;
    canApply: boolean;
    canRollback: boolean;
    canCancel: boolean;
    /** Owner draft for current preparation; no accepted pins or execution grant. */
    prepareAgain?: { reason: 'definition_changed'; selection: IRoleSelection; modelId: string };
}

export interface IRoleResult {
    kind: 'diagnosis' | 'proposal';
    summary: string;
    answer?: string;
    guidance?: IRoleGuidanceEvidence;
    actions?: Array<{ id: string; label: string; path: string; requiresPermission?: boolean }>;
    findings: Array<{ evidenceId: string; detail: string }>;
    nextSteps: string[];
    changes: Array<{ targetKey: string; replacement: string; explanation: string }>;
    projectContext?: IRoleProjectContextReceipt;
    delegations?: Array<{
        roleId: TSystemRoleId;
        state: 'succeeded' | 'failed';
        result?: Omit<IRoleResult, 'delegations'>;
        message?: string;
    }>;
}
