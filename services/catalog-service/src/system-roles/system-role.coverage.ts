import type { TDiagnosticKind, TRoleTargetKind, TSystemRoleId } from './system-role.interfaces';

/**
 * FR-303: the single source for system-question coverage — every class of system
 * questions has a responsible system role, so no question is left with «никто не
 * отвечает». Each ownership is structurally grounded in a real role capability
 * (a target or a diagnostic the role actually has); the coverage test verifies the
 * ground against SYSTEM_ROLE_DEFINITIONS, so a role losing the capability fails the
 * matrix. Owners are documentation-grade: explicit invocation of a role by an agent
 * is FR-310 (entry 5) and stays separate.
 */
export interface ISystemRoleCoverageOwner {
    role: TSystemRoleId;
    target?: TRoleTargetKind;
    diagnostic?: TDiagnosticKind;
    basis: string;
}
export interface ISystemRoleCoverageEntry {
    cls: string;
    label: string;
    owners: ISystemRoleCoverageOwner[];
}
export const SYSTEM_ROLE_COVERAGE: readonly ISystemRoleCoverageEntry[] = [
    {
        cls: 'configuration-computer',
        label: 'Настройка (включая конфигурации на компьютере)',
        owners: [
            {
                role: 'agent-autoconfigurator',
                target: 'plugin-settings',
                basis: 'настройки плагинов/агентов/скиллов — явные текстовые цели роли',
            },
            {
                role: 'agent-ai-admin',
                target: 'adapter',
                basis: 'конфигурация адаптера (протокол и параметры подключения)',
            },
        ],
    },
    {
        cls: 'diagnostics',
        label: 'Диагностика системы',
        owners: [
            {
                role: 'agent-ai-admin',
                diagnostic: 'health',
                basis: 'health/project/bridge/containers — измеренные состояния системы',
            },
        ],
    },
    {
        cls: 'models',
        label: 'Модели',
        owners: [
            {
                role: 'agent-ai-admin',
                target: 'adapter',
                basis: 'адаптер модели: состояние подключения и параметры',
            },
        ],
    },
    {
        cls: 'bridges',
        label: 'Мосты',
        owners: [
            {
                role: 'agent-ai-admin',
                diagnostic: 'bridge',
                basis: 'измерение bridge: онлайн-статусы и связи устройств инициатора',
            },
        ],
    },
    {
        cls: 'skills-plugins-mcp',
        label: 'Навыки, плагины, MCP',
        owners: [
            {
                role: 'agent-autoconfigurator',
                target: 'skill',
                basis: 'скиллы и plugin-settings — выбранные текстовые цели роли',
            },
            {
                role: 'agent-coordinator',
                target: 'skill',
                basis: 'координатор делегирует проверку выбранных навыков/MCP-инструментов (toolKeys) делегатам',
            },
        ],
    },
    {
        cls: 'agents-assets',
        label: 'Агенты и ассеты',
        owners: [
            {
                role: 'agent-coordinator',
                target: 'agent',
                basis: 'цель agent: выбранные карточки агентов проекта',
            },
            {
                role: 'agent-ai-admin',
                diagnostic: 'project',
                basis: 'измерение project: счётчики моделей/агентов/ассетов проекта',
            },
        ],
    },
    {
        cls: 'access',
        label: 'Доступы',
        owners: [
            {
                role: 'agent-ai-admin',
                diagnostic: 'project',
                basis:
                    'состояние проекта (измерение project) + адаптер (протокол доступа к моделям); ' +
                    'изменение доступов — отдельное подтверждённое действие человека',
            },
        ],
    },
    {
        cls: 'data-rag-quirk',
        label: 'Данные (включая RAG/quirk)',
        owners: [
            {
                role: 'agent-indexer',
                diagnostic: 'index',
                basis: 'измерение index: профиль эмбеддинга, снимки, RAG-синхронизация, reindex-планы',
            },
        ],
    },
    {
        cls: 'queues',
        label: 'Очереди',
        owners: [
            {
                role: 'agent-ai-admin',
                diagnostic: 'project',
                basis: 'измерение project: activeOperations (RUNNING/QUEUED) и readiness каталога',
            },
        ],
    },
    {
        cls: 'updates',
        label: 'Обновление',
        owners: [
            {
                role: 'agent-packager',
                target: 'package-source',
                basis: 'pinned-источники и версии доверенных пакетов; сборка — отдельный мастер',
            },
        ],
    },
    {
        cls: 'recovery',
        label: 'Восстановление',
        owners: [
            {
                role: 'agent-indexer',
                diagnostic: 'index',
                basis: 'reindex-планы и снимки; восстановление выполняет владелец после подтверждения',
            },
            {
                role: 'agent-ai-admin',
                diagnostic: 'health',
                basis: 'readiness каталога и состояние compose-проекта (system scope)',
            },
        ],
    },
];
