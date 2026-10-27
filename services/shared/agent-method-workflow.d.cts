export type AgentMethod='bmad'|'openspec'|'combined';
export interface AgentMethodCheck {command:string;args:string[]}
export interface AgentMethodWorkflowPayload {
 protocol:'agent-method-workflow-v1';workflowId:string;requestId:string;projectId:string;bindingId:string;instanceId:string;
 method:AgentMethod;methodVersion:string;stage:'full-cycle';instruction:string;deadlineAt:string;runtime:'opencode';checks:AgentMethodCheck[];
}
export type AgentMethodFailureCode='METHOD_MISSING'|'METHOD_VERSION'|'PROJECT_NOT_INITIALIZED'|'METHOD_WORKFLOW_MISSING'|'RUNTIME_MISSING'|'CHECKS_REQUIRED'|'UNSUPPORTED_PLATFORM'|'EXECUTION_FAILED'|'CHECK_FAILED'|'AUTHORIZATION_LOST'|'UNKNOWN_OUTCOME'|'CANCELLED'|'OUTPUT_LIMIT'|'TIMEOUT'|'WORKSPACE_CHANGED'|'OBSERVATION_LIMIT'|'QUIRK_STORAGE_INVALID';
export interface AgentMethodWorkflowResult {
 protocol:'agent-method-workflow-v1';workflowId:string;method:AgentMethod;methodVersion:string;runtime:'opencode';
 state:'succeeded'|'failed'|'cancelled'|'unknown'|'needs_setup';stage:'prerequisites'|'execution'|'checks'|'completed';codeChanged:boolean;
 changes:Array<{path:string;beforeSha256:string|null;afterSha256:string|null}>;artifacts:Array<{path:string;sha256:string}>;
 checks:Array<AgentMethodCheck&{exitCode:number|null;signal:string|null;state:'passed'|'failed'|'not_run'}>;
 failure?:{code:AgentMethodFailureCode;action:'setup-method'|'setup-runtime'|'inspect-workspace'|'review-result'};
}
export const AGENT_METHOD_WORKFLOW_PROTOCOL:'agent-method-workflow-v1';
export const AGENT_METHOD_WORKFLOW_CAPABILITY:'agent-method-workflow-v1';
export const AGENT_METHOD_WORKFLOW_JOB:'run-agent-method-workflow';
export const AGENT_METHOD_VERSIONS:Readonly<{bmad:'6.12.4';openspec:'1.15.0';combined:'bmad-6.12.4+openspec-1.15.0'}>;
export function normalizeAgentMethodWorkflowPayload(value:unknown):AgentMethodWorkflowPayload;
export function normalizeAgentMethodWorkflowResult(value:unknown,payload?:unknown):AgentMethodWorkflowResult;
export function agentMethodWorkflowDigest(value:unknown):string;
