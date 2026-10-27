export type AgentMethod='bmad'|'openspec'|'combined';
export interface AgentMethodCheck {command:string;args:string[]}
export interface AgentMethodWorkflowAgentIdentity {
 agentId:string;slug:string;version:number;agentsRevision:number;agentsManifestSha256:string;compiledManifestSha256:string;fileSha256:string;configurationJobId:string;
}
export interface AgentMethodWorkflowAgent extends AgentMethodWorkflowAgentIdentity {mode:'primary'|'all';model:import('./project-agents.cjs').ProjectAgentModelMapping}
export interface AgentMethodWorkflowPayload {
 protocol:'agent-method-workflow-v1';workflowId:string;requestId:string;projectId:string;bindingId:string;instanceId:string;
 method:AgentMethod;methodVersion:string;stage:'full-cycle';instruction:string;deadlineAt:string;runtime:'opencode';checks:AgentMethodCheck[];
 agent?:AgentMethodWorkflowAgent;
}
export type AgentMethodFailureCode='METHOD_MISSING'|'METHOD_VERSION'|'PROJECT_NOT_INITIALIZED'|'METHOD_WORKFLOW_MISSING'|'RUNTIME_MISSING'|'CHECKS_REQUIRED'|'UNSUPPORTED_PLATFORM'|'EXECUTION_FAILED'|'CHECK_FAILED'|'AUTHORIZATION_LOST'|'UNKNOWN_OUTCOME'|'CANCELLED'|'OUTPUT_LIMIT'|'TIMEOUT'|'WORKSPACE_CHANGED'|'OBSERVATION_LIMIT'|'QUIRK_STORAGE_INVALID'|'SELECTED_AGENT_NOT_READY';
export interface AgentMethodWorkflowResult {
 protocol:'agent-method-workflow-v1';workflowId:string;method:AgentMethod;methodVersion:string;runtime:'opencode';
 state:'succeeded'|'failed'|'cancelled'|'unknown'|'needs_setup';stage:'prerequisites'|'execution'|'checks'|'completed';codeChanged:boolean;
 changes:Array<{path:string;beforeSha256:string|null;afterSha256:string|null}>;artifacts:Array<{path:string;sha256:string}>;
 checks:Array<AgentMethodCheck&{exitCode:number|null;signal:string|null;state:'passed'|'failed'|'not_run'}>;
 agent?:AgentMethodWorkflowAgentIdentity;
 failure?:{code:AgentMethodFailureCode;action:'setup-method'|'setup-runtime'|'setup-agent'|'inspect-workspace'|'review-result'};
}
export const AGENT_METHOD_WORKFLOW_PROTOCOL:'agent-method-workflow-v1';
export const AGENT_METHOD_WORKFLOW_CAPABILITY:'agent-method-workflow-v1';
export const AGENT_METHOD_SELECTED_AGENT_CAPABILITY:'agent-method-selected-agent-v1';
export const AGENT_METHOD_WORKFLOW_JOB:'run-agent-method-workflow';
export const AGENT_METHOD_VERSIONS:Readonly<{bmad:'6.12.4';openspec:'1.15.0';combined:'bmad-6.12.4+openspec-1.15.0'}>;
export function normalizeAgentMethodWorkflowPayload(value:unknown):AgentMethodWorkflowPayload;
export function normalizeAgentMethodWorkflowResult(value:unknown,payload?:unknown):AgentMethodWorkflowResult;
export function agentMethodWorkflowDigest(value:unknown):string;
export function agentMethodWorkflowAgentIdentity(value:unknown):AgentMethodWorkflowAgentIdentity;
