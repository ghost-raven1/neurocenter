import type { UsagePurpose, UsageStatus } from './types';
export const purposeLabels: Record<UsagePurpose, string> = { chat: 'Чат с моделью', agent: 'Ответ агента', compaction: 'Сжатие истории', 'project-search': 'Поиск по проекту', 'device-embedding': 'Индексирование с компьютера', reindex: 'Переиндексация', learning: 'Проектное обучение', direct: 'Прямой API', verification: 'Проверка модели', research: 'Исследование' };
export const statusLabels: Record<UsageStatus, string> = { pending: 'Выполняется', success: 'Успешно', error: 'Ошибка', cancelled: 'Остановлен', interrupted: 'Результат не подтверждён' };
export const protocolLabels: Record<string, string> = { ollama: 'Локальная Ollama', 'remote-openai': 'OpenAI-совместимый API', 'remote-ollama': 'Удалённая Ollama' };
/** Unknown counters stay distinct from a provider-reported zero; decimal totals keep full integer precision. */
export function usageCount(value: number | string | null): string { return value === null ? 'Нет данных' : new Intl.NumberFormat('ru-RU').format(typeof value === 'string' ? BigInt(value) : value); }
export const usageLatency = (value: number | null): string => value === null ? 'Нет данных' : value < 1000 ? `${value} мс` : `${(value / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с`;
