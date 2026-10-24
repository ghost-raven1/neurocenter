import type { IModel } from '../models/model.types';
import type {RoleMcpPreparedTarget,RoleMcpTargetSelection} from '../../../shared/system-role-mcp.cjs';

export type SystemRoleId = 'agent-ai-admin' | 'agent-autoconfigurator' | 'agent-indexer' | 'agent-packager' | 'agent-coordinator';
export type SystemRoleFlag = 'system_ai_admin' | 'system_autoconfigurator' | 'system_indexer' | 'tool_build_agent' | 'system_coordinator';
export type DiagnosticKind = 'health' | 'project' | 'bridge' | 'containers' | 'index';
export type RoleTargetKind = 'prompt' | 'agent' | 'skill' | 'plugin-settings' | 'adapter' | 'public-chat' | 'package-source' | 'dialog-context';
export type RoleRunState = 'queued' | 'running' | 'awaiting_review' | 'applying' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface RoleTargetSelection { kind: RoleTargetKind; id: string; text?: string; }
export interface RoleSelection { projectId: string | null; instruction: string; diagnostics: DiagnosticKind[]; targets: RoleTargetSelection[]; mcp?:RoleMcpTargetSelection[]; }
export interface StartRoleRun extends RoleSelection { requestId: string; modelId: string; expectedModelPin: string; expectedDefinitionPin: string; consentDigest: string; sourceFeature?: 'system_role_chat'; source?: {kind:'system-role-chat';dialogId:string;turnId:string}; }
export interface RoleDefinition { id: SystemRoleId; name: string; flag: SystemRoleFlag; description: string; prompt: string; targets: readonly RoleTargetKind[]; diagnostics: readonly DiagnosticKind[]; }
/** Facts expose typed measurements, never log text, source files, credentials or arbitrary destinations. */
export interface DiagnosticFact { id: string; kind: DiagnosticKind; checkedAt: string; status: 'measured' | 'unavailable'; data: Record<string, unknown>; }
export interface RoleTargetSnapshot {
    key: string; kind: RoleTargetKind; id: string; version: number; pin: string;
    modelContent: string; before: Record<string, unknown>; editable: boolean;
}
export interface RolePrepared { selection: RoleSelection; definitionPin: string; consentDigest: string; preview: string; targets: RoleTargetSnapshot[]; mcp?:RoleMcpPreparedTarget[]; }
export interface RoleChange { targetKey: string; replacement: string; explanation: string; }
export interface RoleResult {
    kind: 'diagnosis' | 'proposal'; summary: string;
    findings: Array<{ evidenceId: string; detail: string }>;
    nextSteps: string[]; changes: RoleChange[];
    delegations?: RoleDelegationResult[];
}
/** Child answers belong to the same actor, consent, deadline and durable run; they cannot schedule more work. */
export interface RoleDelegationResult { roleId: SystemRoleId; state: 'succeeded' | 'failed'; result?: Omit<RoleResult, 'delegations'>; message?: string; }
export interface RoleStep { at: string; phase: string; message: string; }
export interface RoleApplyReceipt { targetKey: string; version: number; pin: string; owner: string; }
export interface RoleRunRow {
    id: string; agent_id: SystemRoleId; project_id: string | null; actor: string; actor_role: string; request_id: string; request_hash: string;
    request: StartRoleRun; snapshot: RolePrepared; model: IModel; state: RoleRunState; phase: string; revision: number;
    lease_token: string; lease_until: Date | string | null; calls_started: number; facts: DiagnosticFact[];
    result: RoleResult | null; steps: RoleStep[]; applied: RoleApplyReceipt[]; message: string; created_at: Date | string; finished_at: Date | string | null;
}
export interface RoleRunView {
    id: string; agentId: SystemRoleId; projectId: string | null; actor: string; state: RoleRunState; phase: string; revision: number;
    operationId: string; message: string; createdAt: string; finishedAt: string | null; callsStarted: number; modelCallBudget: number;
    modelId: string; modelPin: string; facts: DiagnosticFact[]; result: RoleResult | null; steps: RoleStep[]; applied: RoleApplyReceipt[];
    targets: Array<{ key: string; kind: RoleTargetKind; id: string; version: number; content: string; editable: boolean }>;
    canApply: boolean; canRollback: boolean; canCancel: boolean;
}
