import type { ISkillMeta } from '../skills/skills.model';

export interface ISeedSkill {
    path: string;
    meta: ISkillMeta;
    body: string;
}

const JEST_TEST_BODY = [
    '# SKILL: Jest Testing for React/Redux Projects',
    '',
    '## Role',
    'Ты — Senior Frontend Developer и эксперт по unit- и integration-тестам на Jest и React Testing Library (RTL)',
    'для проекта на стеке React, TypeScript и Redux.',
    '',
    '## Стратегия',
    '- Используй версии Testing Library, зафиксированные в зависимостях проекта.',
    '- Проверяй поведение через доступные роли и подписи элементов.',
    '- Подменяй внешние зависимости; проверяй действия пользователя и результат.',
    '- Дожидайся асинхронных обновлений перед проверкой состояния.',
].join('\n');

const MEMORY_BODY = [
    '# SKILL: Memory & Project Context',
    '',
    '## Role',
    'Ты — Senior Frontend Developer и хранитель «долговременной памяти» проекта: фиксируешь решения,',
    'конвенции, домены, известные подводные камни и восстанавливаешь их между сессиями.',
    '',
    '## Формат хранения',
    'Память хранится в `.md`-файлах: ARCHITECTURE.md, CONVENTIONS.md, DOMAINS.md, DECISIONS.md (ADR),',
    'KNOWN_ISSUES.md, IDIOMS.md и USAGE_LOG.md (журнал: когда и как скилл применялся).',
    '',
    '## Правила',
    '- Отделяй проверенные факты от предположений и указывай источник решения.',
    '- Не сохраняй пароли, токены и персональные данные в документации.',
].join('\n');

const CODE_REVIEW_BODY = [
    '# SKILL: Code Review Helper (project)',
    '',
    '## Role',
    'Помощник код-ревью: анализирует качество кода, находит дефекты (баги, уязвимости, производительность),',
    'оценивает риски изменений и архитектуру. Только анализ — не изменяет код.',
    '',
    '## Формат вывода',
    'Приоритизированный список с `file:line` + JSON-отчёт.',
].join('\n');

/**
 * Общие демонстрационные скиллы для первого запуска.
 *
 * @returns {ISeedSkill[]} список seed-скиллов
 */
export function buildSeedSkills(): ISeedSkill[] {
    const now = '2026-10-10T10:00:00Z';

    return [
        {
            path: 'common/jest-test',
            meta: {
                name: 'Jest Testing (React/Redux)',
                slug: 'jest-test',
                scope: 'common',
                mcp: [],
                plugins: [],
                specialization: 'testing',
                tags: ['react', 'redux', 'jest', 'testing-library'],
                version: 2,
                owner: 'platform',
                updatedAt: now,
                history: [
                    { version: 2, at: now, author: 'platform', note: 'Обновлён демонстрационный пример' },
                    { version: 1, at: '2026-09-01T10:00:00Z', author: 'platform', note: 'init' },
                ],
            },
            body: JEST_TEST_BODY,
        },
        {
            path: 'common/memory',
            meta: {
                name: 'Memory & Project Context',
                slug: 'memory',
                scope: 'common',
                mcp: ['knowledge-graph-mcp'],
                plugins: [],
                specialization: 'memory',
                tags: ['memory', 'context'],
                version: 2,
                owner: 'platform',
                updatedAt: '2026-10-09T10:00:00Z',
                history: [
                    { version: 2, at: '2026-10-09T10:00:00Z', author: 'platform', note: 'Добавлена связь с knowledge-graph-mcp' },
                    { version: 1, at: '2026-08-15T10:00:00Z', author: 'platform', note: 'init' },
                ],
            },
            body: MEMORY_BODY,
        },
        {
            path: 'project-prj-lancedb/code-review-helper',
            meta: {
                name: 'Code Review Helper',
                slug: 'code-review-helper',
                scope: 'project',
                projectId: 'prj-lancedb',
                mcp: ['code-review-mcp'],
                plugins: ['review-bot'],
                specialization: 'review',
                tags: ['review', 'quality'],
                version: 1,
                owner: 'dev@localhost',
                updatedAt: '2026-10-08T10:00:00Z',
                history: [{ version: 1, at: '2026-10-08T10:00:00Z', author: 'dev@localhost', note: 'init' }],
            },
            body: CODE_REVIEW_BODY,
        },
    ];
}
