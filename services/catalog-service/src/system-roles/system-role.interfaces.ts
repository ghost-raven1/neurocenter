import type { ITextContext, ITextAdmission } from '../../../shared/project-text-knowledge.cjs';
import type { IModel } from '../models/model.interfaces';
import type { IRoleMcpPreparedTarget, TRoleMcpTargetSelection } from '../../../shared/system-role-mcp.cjs';

export type TSystemRoleId =
    'agent-ai-admin' | 'agent-autoconfigurator' | 'agent-indexer' | 'agent-packager' | 'agent-coordinator';
export type TSystemRoleFlag =
    'system_ai_admin' | 'system_autoconfigurator' | 'system_indexer' | 'tool_build_agent' | 'system_coordinator';
export type TDiagnosticKind = 'health' | 'project' | 'bridge' | 'containers' | 'index';
export type TRoleTargetKind =
    'prompt' | 'agent' | 'skill' | 'plugin-settings' | 'adapter' | 'public-chat' | 'package-source' | 'dialog-context';
export type TRoleRunState =
    'queued' | 'running' | 'awaiting_review' | 'applying' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface IRoleTargetSelection {
    kind: TRoleTargetKind;
    id: string;
    text?: string;
}
export interface IRoleSelection {
    projectId: string | null;
    instruction: string;
    diagnostics: TDiagnosticKind[];
    targets: IRoleTargetSelection[];
    mcp?: TRoleMcpTargetSelection[];
    textContext?: ITextContext;
}
export interface IStartRoleRun extends IRoleSelection {
    requestId: string;
    modelId: string;
    expectedModelPin: string;
    expectedDefinitionPin: string;
    consentDigest: string;
    sourceFeature?: 'system_role_chat';
    source?: { kind: 'system-role-chat'; dialogId: string; turnId: string };
}
export interface IRoleDefinition {
    id: TSystemRoleId;
    name: string;
    flag: TSystemRoleFlag;
    description: string;
    prompt: string;
    targets: readonly TRoleTargetKind[];
    diagnostics: readonly TDiagnosticKind[];
}
/** Facts expose typed measurements, never log text, source files, credentials or arbitrary destinations. */
export interface IDiagnosticFact {
    id: string;
    kind: TDiagnosticKind;
    checkedAt: string;
    status: 'measured' | 'unavailable';
    data: Record<string, unknown>;
}
export interface IRoleTargetSnapshot {
    key: string;
    kind: TRoleTargetKind;
    id: string;
    version: number;
    pin: string;
    modelContent: string;
    before: Record<string, unknown>;
    editable: boolean;
}
/** Project knowledge is a separate whole-index read grant, never a target/path write permission. */
export interface IRoleProjectGrant {
    scope: 'project-index' | 'project-text';
    projectId: string;
    projectName: string;
    identity: string;
    recipients: TSystemRoleId[];
    generation?: string;
    snapshot?: string;
    textContext?: ITextContext;
    textAdmission?: ITextAdmission;
}
export interface IRoleProjectEvidence {
    status: 'metadata' | 'ready' | 'empty' | 'unavailable';
    project: { id: string; name: string };
    generation?: string;
    snapshot?: string;
    sources: Array<{ id: string; path: string; title?: string; startLine?: number; endLine?: number }>;
    message?: string;
    mode?: 'text';
    textRevision?: number;
    corpusHash?: string;
    textAdmission?: ITextAdmission;
}
export interface IRoleInvocation {
    content: string;
    projectContext?: IRoleProjectEvidence;
}
export interface IRoleGuidanceGrant {
    version: 1;
    projectId: string | null;
}
export interface IRoleGuidanceSource {
    id: string;
    kind: 'help' | 'diagnostic';
    title: string;
    slug?: string;
    revision?: string;
}
export interface IRoleGuidanceEvidence {
    status: 'ready' | 'unavailable';
    checkedAt: string;
    sources: IRoleGuidanceSource[];
    message?: string;
}
export interface IRoleGuidanceAction {
    id: string;
    label: string;
    path: string;
    requiresPermission?: boolean;
}
export interface IRolePrepared {
    selection: IRoleSelection;
    definitionPin: string;
    consentDigest: string;
    preview: string;
    targets: IRoleTargetSnapshot[];
    mcp?: IRoleMcpPreparedTarget[];
    projectContext?: IRoleProjectGrant;
    guidance?: IRoleGuidanceGrant;
}
export interface IRoleChange {
    targetKey: string;
    replacement: string;
    explanation: string;
}
export interface IRoleResult {
    kind: 'diagnosis' | 'proposal';
    summary: string;
    answer?: string;
    guidance?: IRoleGuidanceEvidence;
    actions?: IRoleGuidanceAction[];
    findings: Array<{ evidenceId: string; detail: string }>;
    nextSteps: string[];
    changes: IRoleChange[];
    delegations?: IRoleDelegationResult[];
    projectContext?: IRoleProjectEvidence;
}
/** Child answers belong to the same actor, consent, deadline and durable run; they cannot schedule more work. */
export interface IRoleDelegationResult {
    roleId: TSystemRoleId;
    state: 'succeeded' | 'failed';
    result?: Omit<IRoleResult, 'delegations'>;
    message?: string;
}
export interface IRoleStep {
    at: string;
    phase: string;
    message: string;
}
export interface IRoleApplyReceipt {
    targetKey: string;
    version: number;
    pin: string;
    owner: string;
}
export interface IRoleRunRow {
    id: string;
    agent_id: TSystemRoleId;
    project_id: string | null;
    actor: string;
    actor_role: string;
    request_id: string;
    request_hash: string;
    request: IStartRoleRun;
    snapshot: IRolePrepared;
    model: IModel;
    state: TRoleRunState;
    phase: string;
    revision: number;
    lease_token: string;
    lease_until: Date | string | null;
    calls_started: number;
    facts: IDiagnosticFact[];
    result: IRoleResult | null;
    steps: IRoleStep[];
    applied: IRoleApplyReceipt[];
    message: string;
    created_at: Date | string;
    finished_at: Date | string | null;
}
export interface IRoleRunView {
    id: string;
    agentId: TSystemRoleId;
    projectId: string | null;
    actor: string;
    state: TRoleRunState;
    phase: string;
    revision: number;
    operationId: string;
    message: string;
    createdAt: string;
    finishedAt: string | null;
    callsStarted: number;
    modelCallBudget: number;
    modelId: string;
    modelPin: string;
    facts: IDiagnosticFact[];
    result: IRoleResult | null;
    steps: IRoleStep[];
    applied: IRoleApplyReceipt[];
    targets: Array<{
        key: string;
        kind: TRoleTargetKind;
        id: string;
        version: number;
        content: string;
        editable: boolean;
    }>;
    canApply: boolean;
    canRollback: boolean;
    canCancel: boolean;
    /** Original owner input for a fresh preview; accepted pins and grants are never copied. */
    prepareAgain?: { reason: 'definition_changed'; selection: IRoleSelection; modelId: string };
}
