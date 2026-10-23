export type SystemRoleId = 'agent-ai-admin' | 'agent-autoconfigurator' | 'agent-indexer' | 'agent-packager';
export type RoleFlag = 'system_ai_admin' | 'system_autoconfigurator' | 'system_indexer' | 'tool_build_agent';
export type TargetKind = 'prompt' | 'agent' | 'skill' | 'plugin-settings' | 'adapter' | 'public-chat' | 'package-source' | 'dialog-context';
export type DiagnosticKind = 'health' | 'project' | 'bridge' | 'containers' | 'index';
export interface RoleDefinition { id: SystemRoleId; name: string; flag: RoleFlag; description: string; definitionPin: string; targets: TargetKind[]; diagnostics: DiagnosticKind[]; }
export interface RoleSelection { projectId: string | null; instruction: string; diagnostics: DiagnosticKind[]; targets: Array<{ kind: TargetKind; id: string; text?: string }>; }
export interface RolePrepared { preview: string; consentDigest: string; definitionPin: string; targets: Array<{ key: string; kind: TargetKind; id: string; version: number; editable: boolean }>; }
export interface RoleStart extends RoleSelection { requestId: string; modelId: string; expectedModelPin: string; expectedDefinitionPin: string; consentDigest: string; }
export interface RoleOverview { definitions: RoleDefinition[]; budget: { calls: number; diagnostics: number; targets: number; deadlineMs: number }; models: Array<{ id: string; name: string; pin: string }>; targets: Array<{ kind: TargetKind; id: string; name: string }>; projectId: string | null; }
export interface RoleRun {
    id: string; agentId: SystemRoleId; projectId: string | null; actor: string; state: string; phase: string; revision: number; operationId: string; message: string;
    createdAt: string; finishedAt: string | null; callsStarted: number; modelId: string; modelPin: string;
    facts: Array<{ id: string; kind: DiagnosticKind; checkedAt: string; status: 'measured' | 'unavailable'; data: Record<string, unknown> }>;
    result: { kind: 'diagnosis' | 'proposal'; summary: string; findings: Array<{ evidenceId: string; detail: string }>; nextSteps: string[]; changes: Array<{ targetKey: string; replacement: string; explanation: string }> } | null;
    steps: Array<{ at: string; phase: string; message: string }>; applied: Array<{ targetKey: string; version: number; pin: string; owner: string }>;
    targets: Array<{ key: string; kind: TargetKind; id: string; version: number; content: string; editable: boolean }>;
    canApply: boolean; canRollback: boolean; canCancel: boolean;
}
export const roleName = (id: SystemRoleId): string => id === 'agent-packager' ? 'Упаковщик' : id === 'agent-ai-admin' ? 'AI-админ' : id === 'agent-indexer' ? 'Индексатор' : 'Автоконфигуратор';
export const roleFlag = (id: SystemRoleId): RoleFlag => id === 'agent-packager' ? 'tool_build_agent' : id === 'agent-ai-admin' ? 'system_ai_admin' : id === 'agent-indexer' ? 'system_indexer' : 'system_autoconfigurator';
export const diagnosticNames: Record<DiagnosticKind, string> = { health: 'Готовность каталога', project: 'Состояние проекта', bridge: 'Мои мосты и возможности', containers: 'Контейнеры площадки', index: 'Снимки и синхронизация баз проекта' };
export const targetNames: Record<TargetKind, string> = { prompt: 'Текст промпта', agent: 'Промпт агента', skill: 'Скилл', 'plugin-settings': 'Описание и рекомендации для плагина', adapter: 'Параметры адаптера', 'public-chat': 'Публичный чат проекта · последние 20 сообщений', 'package-source': 'Проверенные метаданные исходника', 'dialog-context': 'Выбранные завершённые ответы личного диалога' };
export const pendingRole = (run: RoleRun | null): boolean => !!run && ['queued', 'running', 'applying'].includes(run.state);
