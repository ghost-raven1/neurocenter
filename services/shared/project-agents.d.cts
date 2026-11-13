export type TAgentMode = 'primary' | 'subagent' | 'all';
export type TAgentPermissionAction = 'allow' | 'ask' | 'deny';
export type TAgentPermissionKey =
    | 'read'
    | 'edit'
    | 'bash'
    | 'glob'
    | 'grep'
    | 'list'
    | 'task'
    | 'external_directory'
    | 'todowrite'
    | 'question'
    | 'webfetch'
    | 'websearch'
    | 'lsp'
    | 'doom_loop'
    | 'skill';
export interface IAgentDefinition {
    description: string;
    prompt: string;
    mode: TAgentMode;
    permission: Partial<Record<TAgentPermissionKey, TAgentPermissionAction>>;
    model?: string;
    temperature?: number;
    topP?: number;
    steps?: number;
}
export type TAgentExtensionKind = 'mcp' | 'plugin' | 'skill';
export type TAgentExtensionOrigin = 'approved' | 'experimental';
/** FR-306: one catalog asset bound to an agent; version + SHA provenance from the approved kit or an active experiment. */
export interface IAgentExtension {
    assetId: string;
    assetKind: TAgentExtensionKind;
    version: number;
    manifest: string;
    origin: TAgentExtensionOrigin;
}
export interface IProjectAgent extends IAgentDefinition {
    id: string;
    slug: string;
    version: number;
    enabled: boolean;
    extensions?: IAgentExtension[];
}
export interface IProjectAgentModelMapping {
    agentId: string;
    provider: string;
    configKey: string;
    runtime: 'remote-openai' | 'remote-ollama';
    model: string;
    baseUrl: string;
    options: import('./opencode-model-scan.cjs').IOpenCodeModelOptions;
    capability: 'chat' | 'vision';
}
export type TProjectAgentModelRequirement =
    | { kind: 'native'; agentId: string; selector: string }
    | {
          kind: 'catalog';
          agentId: string;
          catalogModelId: string;
          modelPin: string;
          runtime: 'remote-openai' | 'remote-ollama' | 'ollama' | 'device-codex';
          sourceSelector?: string;
          runtimeModel: string;
          baseUrl: string | null;
          options: import('./opencode-model-scan.cjs').IOpenCodeModelOptions;
          capability: 'chat' | 'vision';
      };
export interface IProjectAgentsCompilation {
    schemaVersion: 2;
    payloadManifest: string;
    mappings: IProjectAgentModelMapping[];
    agents: IProjectAgentReceipt[];
    manifestSha256: string;
}
export interface IProjectAgentsPayload {
    schemaVersion: 2;
    projectId: string;
    bindingId: string;
    instanceId: string;
    revision: number;
    agents: IProjectAgent[];
    modelRequirements: TProjectAgentModelRequirement[];
    manifestSha256: string;
    compilation?: IProjectAgentsCompilation;
}
export interface IProjectAgentReceipt {
    id: string;
    slug: string;
    version: number;
    enabled: boolean;
    sha256: string;
    extensions?: IAgentExtension[];
}
export interface IProjectAgentsResult {
    schemaVersion: 2;
    projectId: string;
    bindingId: string;
    instanceId: string;
    revision: number;
    manifestSha256: string;
    compiledManifestSha256: string;
    agents: IProjectAgentReceipt[];
    changed: boolean;
    readiness: 'configured';
    checkedAt: string;
    note: string;
    recoveryPath?: string;
}
export const PROJECT_AGENTS_CAPABILITY: 'project-agents-v2';
export const PROJECT_AGENTS_JOB: 'configure-project-agents';
export const PROJECT_AGENTS_NOTE: string;
export const AGENT_PERMISSION_KEYS: readonly TAgentPermissionKey[];
export function normalizeAgentDefinition(value: unknown): IAgentDefinition;
export function agentDefinitionDigest(value: unknown): string;
export function createProjectAgentsPayload(
    value: Omit<IProjectAgentsPayload, 'manifestSha256' | 'compilation' | 'modelRequirements'> & {
        modelRequirements?: TProjectAgentModelRequirement[];
    },
): IProjectAgentsPayload;
export function normalizeProjectAgentsPayload(value: unknown): IProjectAgentsPayload;
export function renderProjectAgent(value: IProjectAgent): string;
export function validateProjectAgentsResult(value: unknown, payload: unknown): IProjectAgentsResult;

export function compileProjectAgents(payload: IProjectAgentsPayload, mappings: unknown): IProjectAgentsCompilation;
export function nativeProjectAgents(
    payload: IProjectAgentsPayload,
    mappings: IProjectAgentModelMapping[],
): IProjectAgent[];
/** Canonical safe model metadata shared by configuration and selected-agent execution. */
export function normalizeProjectAgentModelMapping(value: unknown): IProjectAgentModelMapping;
