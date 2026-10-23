import type { UsagePurpose, UsageStatus } from './types';
export const purposeLabels: Record<UsagePurpose, string> = { chat: 'Чат с моделью', agent: 'Ответ агента', compaction: 'Сжатие истории', 'project-search': 'Поиск по проекту', 'device-embedding': 'Индексирование с компьютера', reindex: 'Переиндексация', learning: 'Проектное обучение', direct: 'Прямой API', verification: 'Проверка модели', research: 'Исследование' };
export const statusLabels: Record<UsageStatus, string> = { pending: 'Выполняется', success: 'Успешно', error: 'Ошибка', cancelled: 'Остановлен', interrupted: 'Результат не подтверждён' };
export const protocolLabels: Record<string, string> = { ollama: 'Локальная Ollama', 'remote-openai': 'OpenAI-совместимый API', 'remote-ollama': 'Удалённая Ollama', 'device-codex': 'Codex на компьютере' };
/** Unknown counters stay distinct from a provider-reported zero; decimal totals keep full integer precision. */
export function usageCount(value: number | string | null | undefined): string { return value == null ? 'Нет данных' : new Intl.NumberFormat('ru-RU').format(typeof value === 'string' ? BigInt(value) : value); }
export const usageLatency = (value: number | null | undefined): string => value == null ? 'Нет данных' : value < 1000 ? `${value} мс` : `${(value / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с`;
export const endpointLabels = {chat: 'Чат', embed: 'Эмбеддинги'};
export const usageActor = (name: string | null | undefined, email: string | null): string => name || email || 'Серверная задача';
export const usageProject = (name: string | null | undefined, id: string | null): string => name || (id ? 'Проект недоступен' : 'Без проекта');
const failureLabels: Record<string, string> = {cancelled: 'Запрос остановлен', rate_wait_timeout: 'Время ожидания лимита истекло', rate_store_unavailable: 'Сервис лимитов временно недоступен', feature_disabled: 'Функция отключена администратором', permission_denied: 'Нет доступа к запросу', provider_error: 'Модель не смогла выполнить запрос', internal_error: 'Не удалось подготовить запрос'};
export const usageFailure = (code: string): string => failureLabels[code] ?? 'Не удалось выполнить запрос';
