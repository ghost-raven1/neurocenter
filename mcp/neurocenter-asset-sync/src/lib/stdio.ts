import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Результат MCP tool'а (тип SDK, чтобы совпадало с контрактом сервера).
 */
export type TToolResult = CallToolResult;

/**
 * Успешный ответ: готовый текст сохраняется, объект сериализуется в JSON.
 */
export function ok(payload: unknown): CallToolResult {
    return {
        content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    };
}

/**
 * Структурированная ошибка (без стектрейсов и внутренних деталей).
 */
export function fail(message: string, detail?: string): CallToolResult {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({ error: message, ...(detail ? { detail } : {}) }, null, 2),
            },
        ],
        isError: true,
    };
}

/**
 * AD-19: инфраструктурные ошибки (spawn/fs/сеть) не уходят в результат tool'а в сыром виде:
 * фиксированное user-safe сообщение (без путей ФС, hostname:port и FS-структуры).
 * Доменные тексты (ошибки, сформированные кодом моста), не попадают сюда и проходят как есть.
 */
const SPAWN_NOT_FOUND = 'Локальный исполняемый файл не найден. Обновите мост.';
const FS_UNAVAILABLE = 'Файл или папка недоступны на этом компьютере. Проверьте доступ и повторите.';
const PERMISSION_DENIED = 'Недостаточно прав для этой операции. Проверьте права доступа и повторите.';
const NETWORK_UNAVAILABLE = 'Соединение с сервисом не установлено. Повторите позже.';

const NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'ECONNRESET',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
]);

/**
 * Фиксированный user-safe текст для инфраструктурной ошибки либо undefined —
 * ошибка не инфраструктурная (доменный текст можно показать).
 */
export function infraErrorMessage(e: unknown): string | undefined {
    const record = e && typeof e === 'object' ? (e as { code?: unknown }) : undefined;
    const code = typeof record?.code === 'string' ? record.code : undefined;
    const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
        return message.startsWith('spawn ') ? SPAWN_NOT_FOUND : FS_UNAVAILABLE;
    }
    if (code === 'EACCES' || code === 'EPERM') return PERMISSION_DENIED;
    if (code !== undefined && (NETWORK_CODES.has(code) || code.startsWith('UND_ERR_'))) return NETWORK_UNAVAILABLE;
    // Без errno на объекте: транспортные сообщения node fetch / undici / child_process.
    if (/spawn \S+ ENOENT/.test(message)) return SPAWN_NOT_FOUND;
    if (/spawn \S+ (EACCES|EPERM)/.test(message)) return PERMISSION_DENIED;
    if (/^(ENOENT|ENOTDIR)[: ]/.test(message)) return FS_UNAVAILABLE;
    if (/^(EACCES|EPERM)[: ]/.test(message)) return PERMISSION_DENIED;
    // Только сырые fetch-failures (undici: TypeError 'fetch failed', детали в .cause);
    // уже нормализованные сообщения (apiTransportError) не трогаем — там только origin и известный код.
    if (/^fetch failed/.test(message) || (e as { name?: unknown } | null)?.name === 'TimeoutError') {
        return NETWORK_UNAVAILABLE;
    }
    return undefined;
}

/**
 * Человекочитаемое сообщение об ошибке (без стектрейса; AD-19: инфраструктурные — фикс.).
 */
export function errMsg(e: unknown): string {
    const infra = infraErrorMessage(e);
    if (infra !== undefined) return infra;
    if (e instanceof Error && e.message) {
        return e.message;
    }
    if (typeof e === 'string') {
        return e;
    }
    return 'неизвестная ошибка';
}
