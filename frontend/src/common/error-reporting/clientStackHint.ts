/**
 * AD-O5 (res-obs 6.11): client stack-hint — кадры без значений (AD-O8/AD-19).
 *
 * Первая строка error.stack содержит error.message — она НЕ уходит (тот же
 * принцип, что buildStackHint в shared/crash-handler.cjs, но строже для
 * browser-данных: не-Error причины не раскрываются вовсе, только тип).
 */

/** Ограничение hint в байтах (AD-O5 OQ-1). */
export const CLIENT_STACK_HINT_MAX_BYTES = 4096;
/** Пометка об обрезке (учитывается в лимите: итог не длиннее maxBytes). */
const TRUNCATION_MARKER = '…[truncated]';
/** Не более 20 кадров (как crash-handler). */
const MAX_FRAMES = 20;

const encoder = new TextEncoder();

/** Отсекает строку до maxBytes байт UTF-8 с пометкой (посимвольно, без разрыва кодов).
 * Маркер резервируется в лимите: итог не длиннее maxBytes (каталог отклоняет > 4 КБ). */
export function truncateToBytes(value: string, maxBytes: number): string {
    if (encoder.encode(value).byteLength <= maxBytes) {
        return value;
    }
    const limit = maxBytes - encoder.encode(TRUNCATION_MARKER).byteLength;
    let out = '';
    let size = 0;
    for (const char of value) {
        const charBytes = encoder.encode(char).byteLength;
        if (size + charBytes > limit) {
            break;
        }
        out += char;
        size += charBytes;
    }
    return `${out}${TRUNCATION_MARKER}`;
}

/**
 * Stack-hint из Error-подобного значения: кадры (без первой строки с message),
 * top-20, trunc до 4 КБ. Не-Error — только тип причины (значения не раскрываются).
 */
export function buildClientStackHint(reason: unknown): string | null {
    const error = reason as { stack?: unknown } | null | undefined;
    if (typeof error?.stack !== 'string' || !error.stack) {
        if (reason === null || reason === undefined) {
            return 'Error: unknown';
        }
        return `Error: ${typeof reason}`;
    }
    const frames = error.stack
        .split('\n')
        // Первая строка — «Error: message»: message в hint не уходит (AD-O8).
        .slice(1)
        .map((frame) => frame.trim())
        .filter((frame) => frame.length > 0)
        .slice(0, MAX_FRAMES);
    if (!frames.length) {
        return null;
    }
    return truncateToBytes(frames.join('\n'), CLIENT_STACK_HINT_MAX_BYTES);
}

/** Приводит произвольный вход к safe stack-hint (строка ≤ 4 КБ или null). */
export function sanitizeClientStackHint(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join('\n');
    if (!trimmed) {
        return null;
    }
    return truncateToBytes(trimmed, CLIENT_STACK_HINT_MAX_BYTES);
}
