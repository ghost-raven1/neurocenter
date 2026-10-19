import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Результат MCP tool'а (тип SDK, чтобы совпадало с контрактом сервера).
 */
export type TToolResult = CallToolResult;

/**
 * Успешный ответ: готовый текст сохраняется, объект сериализуется в JSON.
 */
export function ok(payload: unknown): CallToolResult {
    return { content: [ { type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) } ] };
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
 * Человекочитаемое сообщение об ошибке (без стектрейса).
 */
export function errMsg(e: unknown): string {
    if (e instanceof Error && e.message) {
        return e.message;
    }
    if (typeof e === 'string') {
        return e;
    }
    return 'неизвестная ошибка';
}
