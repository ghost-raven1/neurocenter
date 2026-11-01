import type { TTargetKind, TDiagnosticKind } from './interfaces';

export const diagnosticNames: Record<TDiagnosticKind, string> = {
    health: 'Готовность каталога',
    project: 'Состояние проекта',
    bridge: 'Мои мосты и возможности',
    containers: 'Контейнеры площадки',
    index: 'Снимки и синхронизация баз проекта',
};

export const targetNames: Record<TTargetKind, string> = {
    prompt: 'Текст промпта',
    agent: 'Промпт агента',
    skill: 'Скилл',
    'plugin-settings': 'Описание и рекомендации для плагина',
    adapter: 'Параметры адаптера',
    'public-chat': 'Публичный чат проекта · последние 20 сообщений',
    'package-source': 'Проверенные метаданные исходника',
    'dialog-context': 'Выбранные завершённые ответы личного диалога',
};
