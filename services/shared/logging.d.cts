export type TLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Скалярные значения полей строки (AD-O1: без произвольных полей). */
export type TLogField = string | number | boolean;

/**
 * Поля вызова: err (unknown — из ошибки в строку уходят только allowlist-поля
 * AD-O8: name, code, causeCode) + скалярные ключи. Сигнатура индекса — unknown,
 * потому что TS запрещает `unknown`-проприетет под скалярной индексной сигнатурой;
 * скалярность остальных полей гарантируется runtime (TypeError при нарушении, AD-O1).
 */
export interface ILogFields {
    /** Ошибка: в строку уходят только allowlist-поля AD-O8 (name, code, causeCode). */
    err?: unknown;
    [key: string]: TLogField | unknown;
}

export interface IChildBindings {
    [key: string]: TLogField;
}

export interface IJsonLogger {
    debug(msg: string, fields?: ILogFields): void;
    info(msg: string, fields?: ILogFields): void;
    warn(msg: string, fields?: ILogFields): void;
    error(msg: string, fields?: ILogFields): void;
    /** Производный логгер с фиксированными bindings (только скаляры). */
    child(bindings?: IChildBindings): IJsonLogger;
}

interface ICreateLoggerOptions {
    /** Точка записи (тесты); по умолчанию stdout. Строка пишется целиком, с \n. */
    write?: (line: string) => void;
    /** Точка времени (тесты); по умолчанию new Date().toISOString() (RFC3339 UTC). */
    now?: () => string;
}

/**
 * AD-O1: JSON-line логгер: { ts, level, service, requestId, msg, err?, ...bindings }.
 * requestId — из ALS-контекста request-context.cjs, вне контекста — 'background'.
 */
export function createLogger(service: string, options?: ICreateLoggerOptions): IJsonLogger;
