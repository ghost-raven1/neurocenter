export type SystemRoleId = 'agent-ai-admin' | 'agent-autoconfigurator' | 'agent-indexer' | 'agent-packager' | 'agent-coordinator';
export type RoleFlag = 'system_ai_admin' | 'system_autoconfigurator' | 'system_indexer' | 'tool_build_agent' | 'system_coordinator';
export type TargetKind = 'prompt' | 'agent' | 'skill' | 'plugin-settings' | 'adapter' | 'public-chat' | 'package-source' | 'dialog-context';
export type DiagnosticKind = 'health' | 'project' | 'bridge' | 'containers' | 'index';
export interface RoleDefinition { id: SystemRoleId; name: string; flag: RoleFlag; description: string; definitionPin: string; targets: TargetKind[]; diagnostics: DiagnosticKind[]; }
export type RoleMcpTarget=({runtime:'server'}|{runtime:'device';deviceId:string;bindingId:string;instanceId:string;configurationRevisions:Array<{assetId:string;manifest:string;revision:string|null}>})&{assetId:string;assetKind?:'mcp'|'plugin';version:number;manifest:string};
export type RoleMcpSelection=RoleMcpTarget&{discoveryId:string;tools:Array<{name:string;schemaDigest:string}>};
export interface RoleMcpTool {name:string;description:string;schemaDigest:string;inputSchema:Record<string,unknown>;annotations?:Record<string,unknown>}
export interface RoleSelection { projectId: string | null; instruction: string; diagnostics: DiagnosticKind[]; targets: Array<{ kind: TargetKind; id: string; text?: string }>; mcp?:RoleMcpSelection[]; }
/** Server-owned read grant; it is never part of a client selection or start request. */
export interface RoleProjectContextGrant { scope: 'project-index'; projectId: string; projectName: string; identity: string; recipients: SystemRoleId[]; generation?: string; snapshot?: string; }
export interface RoleProjectContextSource { id: string; path: string; title?: string; startLine?: number; endLine?: number; }
export interface RoleProjectContextReceipt { status: 'metadata' | 'ready' | 'empty' | 'unavailable'; project: { id: string; name: string }; generation?: string; snapshot?: string; sources: RoleProjectContextSource[]; message?: string; }
export interface RoleGuidanceEvidence {status: 'ready' | 'unavailable'; checkedAt: string; sources: Array<{id: string; kind: 'help' | 'diagnostic'; title: string; slug?: string; revision?: string}>; message?: string;}
export interface RolePrepared { preview: string; consentDigest: string; definitionPin: string; targets: Array<{ key: string; kind: TargetKind; id: string; version: number; editable: boolean }>; mcp?:Array<{target:RoleMcpSelection;tools:Array<RoleMcpTool&{toolKey:string}>}>; projectContext?: RoleProjectContextGrant; }
export interface RoleStart extends RoleSelection { requestId: string; modelId: string; expectedModelPin: string; expectedDefinitionPin: string; consentDigest: string; }
export interface RoleOverview { definitions: RoleDefinition[]; budget: { calls: number; diagnostics: number; targets: number; deadlineMs: number }; models: Array<{ id: string; name: string; pin: string }>; targets: Array<{ kind: TargetKind; id: string; name: string }>; projectId: string | null; }
export interface RoleRun {
    id: string; agentId: SystemRoleId; projectId: string | null; actor: string; state: string; phase: string; revision: number; operationId: string; message: string;
    createdAt: string; finishedAt: string | null; callsStarted: number; modelCallBudget?: number; modelId: string; modelPin: string;
    facts: Array<{ id: string; kind: DiagnosticKind; checkedAt: string; status: 'measured' | 'unavailable'; data: Record<string, unknown> }>;
    result: RoleResult | null;
    steps: Array<{ at: string; phase: string; message: string }>; applied: Array<{ targetKey: string; version: number; pin: string; owner: string }>;
    targets: Array<{ key: string; kind: TargetKind; id: string; version: number; content: string; editable: boolean }>;
    canApply: boolean; canRollback: boolean; canCancel: boolean;
    /** Owner draft for current preparation; no accepted pins or execution grant. */
    prepareAgain?: { reason: 'definition_changed'; selection: RoleSelection; modelId: string };
}
export interface RoleResult { kind: 'diagnosis' | 'proposal'; summary: string; answer?: string; guidance?: RoleGuidanceEvidence; actions?: Array<{id: string; label: string; path: string; requiresPermission?: boolean}>; findings: Array<{ evidenceId: string; detail: string }>; nextSteps: string[]; changes: Array<{ targetKey: string; replacement: string; explanation: string }>;
    projectContext?: RoleProjectContextReceipt;
    delegations?: Array<{ roleId: SystemRoleId; state: 'succeeded' | 'failed'; result?: Omit<RoleResult, 'delegations'>; message?: string }>; }
export const roleName = (id: SystemRoleId): string => id === 'agent-coordinator' ? 'Координатор' : id === 'agent-packager' ? 'Упаковщик' : id === 'agent-ai-admin' ? 'AI-админ' : id === 'agent-indexer' ? 'Индексатор' : 'Автоконфигуратор';
export const roleFlag = (id: SystemRoleId): RoleFlag => id === 'agent-coordinator' ? 'system_coordinator' : id === 'agent-packager' ? 'tool_build_agent' : id === 'agent-ai-admin' ? 'system_ai_admin' : id === 'agent-indexer' ? 'system_indexer' : 'system_autoconfigurator';
/** MCP adds at most six model steps under the same bounded workflow. */
export const roleCallBudget = (id: SystemRoleId, mcp = false): number => (id === 'agent-coordinator' ? 5 : 2) + (mcp ? 6 : 0);
export const diagnosticNames: Record<DiagnosticKind, string> = { health: 'Готовность каталога', project: 'Состояние проекта', bridge: 'Мои мосты и возможности', containers: 'Контейнеры площадки', index: 'Снимки и синхронизация баз проекта' };
export const targetNames: Record<TargetKind, string> = { prompt: 'Текст промпта', agent: 'Промпт агента', skill: 'Скилл', 'plugin-settings': 'Описание и рекомендации для плагина', adapter: 'Параметры адаптера', 'public-chat': 'Публичный чат проекта · последние 20 сообщений', 'package-source': 'Проверенные метаданные исходника', 'dialog-context': 'Выбранные завершённые ответы личного диалога' };
export const pendingRole = (run: RoleRun | null): boolean => !!run && ['queued', 'running', 'applying'].includes(run.state);
