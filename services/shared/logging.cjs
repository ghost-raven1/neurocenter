'use strict';
const { BACKGROUND_REQUEST_ID, getRequestId } = require('./request-context.cjs');

/**
 * AD-O1 (6.6): единая лог-схема — JSON lines в stdout (docker json-file захватывает).
 *
 * Схема строки: { ts (RFC3339 UTC), level, service, requestId, msg, err?, ...bindings }.
 * - requestId — из ALS-контекста (request-context.cjs); вне контекста — маркер
 *   'background' (поле никогда не отсутствует). Фоновые работы кладут jobId в то же поле.
 * - err — только allowlist-поля AD-O8: name, code, causeCode (cause.code).
 *   error.message, тела запросов и заголовки в лог не уходят.
 * - bindings/поля строки — только скаляры (string/number/boolean), ключи фиксированы
 *   в коде вызова (AD-O1: без произвольных полей).
 * - Запрещены raw console.log/error и прямой Nest Logger в src сервисов — drift-тест.
 */
const RESERVED = new Set(['ts', 'level', 'service', 'requestId', 'msg', 'err']);

function isScalar(value) {
    return (
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
    );
}

/** AD-O8: из ошибки — только name, code и cause.code; message не передаётся. */
function serializeError(err) {
    if (err === undefined || err === null) return undefined;
    const value = err instanceof Error || typeof err === 'object' ? err : { name: 'Error', message: String(err) };
    const out = { name: typeof value.name === 'string' && value.name !== '' ? value.name : 'Error' };
    if (value.code !== undefined && value.code !== null) out.code = String(value.code);
    const cause = value.cause;
    if (cause && typeof cause === 'object' && cause.code !== undefined && cause.code !== null) {
        out.causeCode = String(cause.code);
    }
    return out;
}

function createLogger(service, options = {}) {
    if (typeof service !== 'string' || service === '') {
        throw new TypeError('createLogger: service — непустая строка.');
    }
    const write = options.write ?? ((line) => process.stdout.write(line + '\n'));
    const now = options.now ?? (() => new Date().toISOString());

    function make(bindings) {
        const emit = (level, msg, fields) => {
            const line = {
                ts: now(),
                level,
                service,
                requestId: getRequestId() || BACKGROUND_REQUEST_ID,
                msg: String(msg),
            };
            if (bindings) {
                for (const [key, value] of Object.entries(bindings)) line[key] = value;
            }
            if (fields && typeof fields === 'object') {
                for (const [key, value] of Object.entries(fields)) {
                    if (key === 'err' || RESERVED.has(key)) continue;
                    if (!isScalar(value)) {
                        throw new TypeError(`createLogger(${service}): поле "${key}" должно быть string/number/boolean.`);
                    }
                    line[key] = value;
                }
                const err = serializeError(fields.err);
                if (err) line.err = err;
            }
            write(JSON.stringify(line));
        };
        return {
            debug: (msg, fields) => emit('debug', msg, fields),
            info: (msg, fields) => emit('info', msg, fields),
            warn: (msg, fields) => emit('warn', msg, fields),
            error: (msg, fields) => emit('error', msg, fields),
            /** Производный логгер с фиксированными bindings (только скалярные значения). */
            child: (childBindings) => {
                if (childBindings && typeof childBindings === 'object') {
                    for (const [key, value] of Object.entries(childBindings)) {
                        if (RESERVED.has(key)) {
                            throw new TypeError(`createLogger(${service}): child-ключ "${key}" зарезервирован.`);
                        }
                        if (!isScalar(value)) {
                            throw new TypeError(`createLogger(${service}): child-значение "${key}" должно быть скаляром.`);
                        }
                    }
                }
                return make(bindings ? { ...bindings, ...childBindings } : childBindings);
            },
        };
    }

    return make(undefined);
}

module.exports = { BACKGROUND_REQUEST_ID, createLogger };
