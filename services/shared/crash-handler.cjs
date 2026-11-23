'use strict';

/**
 * AD-O5 (res-obs 6.10): единая crash-политика всех сервисов.
 *
 * uncaughtException / unhandledRejection →
 *   1) structured-лог (safe-поля AD-O8: msg фиксированный, err — allowlist
 *      name/code/causeCode; requestId — из контекста, вне контекста 'background');
 *   2) запись в error-store (best-effort, timeout ~2 s — PG-down/авария
 *      доставки не блокируют завершение процесса);
 *   3) process.exit(1) ВСЕГДА — контейнер перезапускается docker-политикой.
 *
 * «Захватить и жить дальше» запрещено (AD-O5): после uncaughtException
 * состояние процесса неизвестно (частичные транзакции, коррумпированные
 * счётчики) — безопаснее контролируемый перезапуск (идемпотентные init'ы,
 * outbox'ы переживают restart).
 *
 * В crash-лог не уходит error.message (AD-O8) — логгер сериализует только
 * allowlist-поля; диагностический stack-hint (кадры + имена, без значений)
 * пишется в error-store.
 */

const { randomUUID } = require('node:crypto');
const { getRequestId } = require('./request-context.cjs');

const MAX_STACK_FRAMES = 20;
const MAX_STACK_HINT_BYTES = 4096;
const REPORT_TIMEOUT_MS = 2000;

function truncateToBytes(value, maxBytes) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length <= maxBytes) {
        return value;
    }
    // subarray(...).toString('utf8') сам отбрасывает незавершённый код-поинт.
    return bytes.subarray(0, maxBytes).toString('utf8') + '…[truncated]';
}

/**
 * AD-O8 stack-hint (OQ-1): кадры (file:line:col) + имя/код ошибки — БЕЗ
 * значений переменных и БЕЗ первой строки err.stack (там error.message).
 * Top-20 кадров, не более 4 KB.
 *
 * @param {unknown} reason ошибка (или произвольная причина rejection).
 * @param {{ maxFrames?: number, maxBytes?: number }} [options]
 */
function buildStackHint(reason, options = {}) {
    const maxFrames = options.maxFrames ?? MAX_STACK_FRAMES;
    const maxBytes = options.maxBytes ?? MAX_STACK_HINT_BYTES;
    if (!reason || typeof reason !== 'object') {
        return truncateToBytes('Error: ' + String(reason === undefined ? 'unknown' : reason), maxBytes);
    }
    const name = typeof reason.name === 'string' && reason.name !== '' ? reason.name : 'Error';
    const head =
        typeof reason.code === 'string' && reason.code !== '' ? `${name} (code=${reason.code})` : name;
    const lines = [head];
    if (typeof reason.stack === 'string') {
        let frames = 0;
        for (const line of reason.stack.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('at ')) {
                continue; // только кадры: первая строка (имя: сообщение) не берётся
            }
            lines.push('    ' + trimmed);
            frames++;
            if (frames >= maxFrames) {
                break;
            }
        }
    }
    return truncateToBytes(lines.join('\n'), maxBytes);
}

/**
 * Устанавливает crash-политику процесса. Возвращает dispose() — снятие
 * обработчиков (тесты).
 *
 * @param {{
 *   service: string,
 *   log: { error: (msg: string, fields?: Record<string, unknown>) => void },
 *   reportError: (event: { id: string, service: string, level: 'critical', requestId: string | null, message: string, stackHint: string }) => unknown,
 *   record?: (level: 'error' | 'critical') => void,
 * }} params
 *   - log — логгер 6.6 (createLogger); ошибка передаётся полем err (allowlist AD-O8).
 *   - reportError — запись в error-store (best-effort; PG — прямой insert,
 *     non-PG сервисы — append в error-outbox); бросок/зависание не фатальны.
 *   - record — опциональный in-process счётчик метрик (observability).
 */
function installCrashHandler({ service, log, reportError, record }) {
    if (typeof service !== 'string' || service === '') {
        throw new TypeError('installCrashHandler: service — непустая строка.');
    }
    if (!log || typeof log.error !== 'function') {
        throw new TypeError('installCrashHandler: нужен логгер 6.6 с log.error.');
    }
    if (typeof reportError !== 'function') {
        throw new TypeError('installCrashHandler: reportError — функция записи в error-store.');
    }
    let handling = false;

    const handle = (kind, reason) => {
        // Повторный crash во время обработки: выходим немедленно (без вложенных report).
        if (handling) {
            process.exit(1);
            return;
        }
        handling = true;
        const error = reason instanceof Error ? reason : Object.assign(new Error('crash'), { name: 'Error' });
        try {
            log.error(`crash.${kind}`, { err: error });
        } catch {
            // Лог не должен блокировать завершение (AD-O5: exit всегда).
        }
        const event = {
            id: randomUUID(),
            service,
            level: 'critical',
            requestId: getRequestId() || null,
            message: `crash.${kind}`,
            stackHint: buildStackHint(reason),
        };
        if (typeof record === 'function') {
            try {
                record('critical');
            } catch {
                // Метрика не должна блокировать завершение.
            }
        }
        let timer;
        const timeoutGate = new Promise((resolve) => {
            timer = setTimeout(resolve, REPORT_TIMEOUT_MS);
        });
        Promise.race([
            Promise.resolve()
                .then(() => reportError(event))
                .catch(() => undefined),
            timeoutGate,
        ]).then(() => {
            clearTimeout(timer);
            process.exit(1);
        });
    };

    const onUncaughtException = (error) => handle('uncaughtException', error);
    const onUnhandledRejection = (reason) => handle('unhandledRejection', reason);
    process.on('uncaughtException', onUncaughtException);
    process.on('unhandledRejection', onUnhandledRejection);
    return () => {
        process.removeListener('uncaughtException', onUncaughtException);
        process.removeListener('unhandledRejection', onUnhandledRejection);
        handling = false;
    };
}

module.exports = { buildStackHint, installCrashHandler };
