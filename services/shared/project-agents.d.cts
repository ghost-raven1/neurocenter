export type AgentMode='primary'|'subagent'|'all';
export type AgentPermissionAction='allow'|'ask'|'deny';
export type AgentPermissionKey='read'|'edit'|'bash'|'glob'|'grep'|'list'|'task'|'external_directory'|'todowrite'|'question'|'webfetch'|'websearch'|'lsp'|'doom_loop'|'skill';
export interface AgentDefinition {
    description:string;prompt:string;mode:AgentMode;permission:Partial<Record<AgentPermissionKey,AgentPermissionAction>>;
    model?:string;temperature?:number;topP?:number;steps?:number;
}
export interface ProjectAgent extends AgentDefinition {id:string;slug:string;version:number;enabled:boolean}
export interface ProjectAgentsPayload {
    schemaVersion:1;projectId:string;bindingId:string;instanceId:string;revision:number;agents:ProjectAgent[];manifestSha256:string;
}
export interface ProjectAgentReceipt {id:string;slug:string;version:number;enabled:boolean;sha256:string}
export interface ProjectAgentsResult {
    schemaVersion:1;projectId:string;bindingId:string;instanceId:string;revision:number;manifestSha256:string;agents:ProjectAgentReceipt[];
    changed:boolean;readiness:'configured';checkedAt:string;note:string;recoveryPath?:string;
}
export const PROJECT_AGENTS_CAPABILITY:'project-agents-v1';
export const PROJECT_AGENTS_JOB:'configure-project-agents';
export const PROJECT_AGENTS_NOTE:string;
export const AGENT_PERMISSION_KEYS:readonly AgentPermissionKey[];
export function normalizeAgentDefinition(value:unknown):AgentDefinition;
export function agentDefinitionDigest(value:unknown):string;
export function createProjectAgentsPayload(value:Omit<ProjectAgentsPayload,'manifestSha256'>):ProjectAgentsPayload;
export function normalizeProjectAgentsPayload(value:unknown):ProjectAgentsPayload;
export function renderProjectAgent(value:ProjectAgent):string;
export function validateProjectAgentsResult(value:unknown,payload:unknown):ProjectAgentsResult;
