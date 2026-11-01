import type { TSystemRoleId, TRoleFlag, IRoleRun } from './interfaces';

export const roleName = (id: TSystemRoleId): string =>
    id === 'agent-coordinator'
        ? 'Координатор'
        : id === 'agent-packager'
          ? 'Упаковщик'
          : id === 'agent-ai-admin'
            ? 'AI-админ'
            : id === 'agent-indexer'
              ? 'Индексатор'
              : 'Автоконфигуратор';

export const roleFlag = (id: TSystemRoleId): TRoleFlag =>
    id === 'agent-coordinator'
        ? 'system_coordinator'
        : id === 'agent-packager'
          ? 'tool_build_agent'
          : id === 'agent-ai-admin'
            ? 'system_ai_admin'
            : id === 'agent-indexer'
              ? 'system_indexer'
              : 'system_autoconfigurator';

/** MCP adds at most six model steps under the same bounded workflow. */
export const roleCallBudget = (id: TSystemRoleId, mcp = false): number =>
    (id === 'agent-coordinator' ? 5 : 2) + (mcp ? 6 : 0);

export const pendingRole = (run: IRoleRun | null): boolean =>
    !!run && ['queued', 'running', 'applying'].includes(run.state);
