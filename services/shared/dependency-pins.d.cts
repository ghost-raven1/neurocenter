/** Точная версия зависимости; имя и последняя версия не участвуют в выборе пакета. */
export interface IDependencyPin {
    kind: 'mcp' | 'plugin';
    id: string;
    version: number;
    manifest: string;
}

/** Возвращает проверенные ссылки в стабильном порядке; отсутствие поля означает пустой набор. */
export function normalizeDependencyPins(value: unknown): IDependencyPin[];
