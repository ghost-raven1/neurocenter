'use strict';
/**
 * AD-9 config engine: typed env schema + единая валидация + fail-fast с АГРЕГИРОВАННЫМ отчётом.
 *
 * Каждый сервис владеет своим config-модулем (src/config.ts), который объявляет schema
 * (имя + тип + описание) и вызывает loadConfig(schema, env) на старте. Config-модуль — ЕДИНСТВЕННЫЙ
 * владелец чтения окружения и валидации его значений; shared-модули лимитов принимают значения
 * параметром (инжекция), а не читают env сами (AD-7/AD-9).
 *
 * Правила:
 *  - числовые env — validated positive safe-integer (NaN/не-число/≤0/overflow = fail-fast с именем переменной);
 *  - все невалидные переменные собираются в ОДИН агрегированный отчёт (не fail на первой);
 *  - значения секретов в отчёте всегда маскируются (названия переменных — да, значения — нет);
 *  - валидация выполняется ЛЕНИВО: модуль не читает process.env при импорте (AD-7).
 */

const INTEGER_RX = /^\d+$/;

/**
 * @typedef {'positiveInteger'|'nonNegativeInteger'|'integer'|'string'|'secret'|'boolean'} EnvType
 * @typedef {{ name: string, type: EnvType, required?: boolean, default?: unknown,
 *             description?: string, min?: number, max?: number }} EnvSpec
 * @typedef {{ name: string, type: EnvType, description?: string, value?: unknown,
 *             masked?: boolean }} EnvReportEntry
 */

/** Агрегированная ошибка конфигурации окружения. */
class ConfigEnvironmentError extends Error {
    /** @param {string[]} issues */
    constructor(issues) {
        super('Ошибка конфигурации окружения:\n' + issues.map((issue) => '  - ' + issue).join('\n'));
        this.name = 'ConfigEnvironmentError';
        /** @type {string[]} */
        this.issues = issues;
    }
}

/** Разрешает значение числового env как positive safe-integer (≥1). */
function positiveInteger(name, raw, spec) {
    if (raw === undefined || raw === '') {
        if (spec.required) return { error: name + ': требуется значение' };
        return { value: spec.default };
    }
    if (typeof raw !== 'string' || !INTEGER_RX.test(raw)) {
        return { error: name + ': ожидается положительное целое число' };
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
        return { error: name + ': ожидается положительное safe-integer (NaN/overflow/≤0 — fail-fast)' };
    }
    if (spec.min !== undefined && value < spec.min) {
        return { error: name + ': должно быть не меньше ' + spec.min };
    }
    if (spec.max !== undefined && value > spec.max) {
        return { error: name + ': должно быть не больше ' + spec.max };
    }
    return { value };
}

/** Разрешает значение числового env как non-negative safe-integer (≥0). */
function nonNegativeInteger(name, raw, spec) {
    if (raw === undefined || raw === '') {
        if (spec.required) return { error: name + ': требуется значение' };
        return { value: spec.default };
    }
    if (typeof raw !== 'string' || !INTEGER_RX.test(raw)) {
        return { error: name + ': ожидается неотрицательное целое число' };
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
        return { error: name + ': ожидается неотрицательный safe-integer' };
    }
    if (spec.min !== undefined && value < spec.min) {
        return { error: name + ': должно быть не меньше ' + spec.min };
    }
    if (spec.max !== undefined && value > spec.max) {
        return { error: name + ': должно быть не больше ' + spec.max };
    }
    return { value };
}

/** Разрешает значение целочисленного env (знак разрешён), в пределах min/max. */
function integerType(name, raw, spec) {
    if (raw === undefined || raw === '') {
        if (spec.required) return { error: name + ': требуется значение' };
        return { value: spec.default };
    }
    if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw)) {
        return { error: name + ': ожидается целое число' };
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
        return { error: name + ': ожидается safe-integer (NaN/overflow — fail-fast)' };
    }
    if (spec.min !== undefined && value < spec.min) {
        return { error: name + ': должно быть не меньше ' + spec.min };
    }
    if (spec.max !== undefined && value > spec.max) {
        return { error: name + ': должно быть не больше ' + spec.max };
    }
    return { value };
}

/** Разрешает строковый env (нет числовой семантики; только required/empty-проверка). */
function stringType(name, raw, spec) {
    if (raw === undefined || raw === '') {
        if (spec.required) return { error: name + ': требуется значение' };
        return { value: spec.default };
    }
    return { value: raw };
}

/** Разрешает boolean env: 'true'/'false' (default применяется при отсутствии). */
function booleanType(name, raw, spec) {
    if (raw === undefined || raw === '') {
        if (spec.required) return { error: name + ': требуется значение (true/false)' };
        return { value: spec.default };
    }
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: name + ': ожидается true или false' };
}

/**
 * Валидирует и загружает окружение по schema. Возвращает { values, report } либо
 * бросает ConfigEnvironmentError со всеми ошибками сразу (агрегированный отчёт).
 *
 * @param {EnvSpec[]} schema
 * @param {NodeJS.ProcessEnv} env
 * @param {(values: Record<string, unknown>) => string[]} [validate] перекрёстные проверки
 */
function loadConfig(schema, env, validate) {
    const values = {};
    const issues = [];
    const entries = [];
    for (const spec of schema) {
        let result;
        switch (spec.type) {
            case 'positiveInteger':
                result = positiveInteger(spec.name, env[spec.name], spec);
                break;
            case 'nonNegativeInteger':
                result = nonNegativeInteger(spec.name, env[spec.name], spec);
                break;
            case 'integer':
                result = integerType(spec.name, env[spec.name], spec);
                break;
            case 'boolean':
                result = booleanType(spec.name, env[spec.name], spec);
                break;
            case 'secret':
                result = stringType(spec.name, env[spec.name], { ...spec, required: false });
                break;
            case 'string':
            default:
                result = stringType(spec.name, env[spec.name], spec);
                break;
        }
        if (result.error) {
            issues.push(result.error);
        } else {
            values[spec.name] = result.value;
            const masked = spec.type === 'secret';
            entries.push({
                name: spec.name,
                type: spec.type,
                ...(spec.description ? { description: spec.description } : {}),
                value: masked ? '***' : result.value,
                ...(masked ? { masked: true } : {}),
            });
        }
    }
    if (validate) {
        const extra = validate(values);
        if (Array.isArray(extra)) issues.push(...extra);
    }
    if (issues.length) throw new ConfigEnvironmentError(issues);
    return { values, report: entries };
}

/** Человекочитаемый отчёт конфигурации (имена + типы + описания; значения секретов маскированы). */
function formatConfigReport(report) {
    return report
        .map((entry) => {
            const value = entry.masked ? '(маскировано)' : JSON.stringify(entry.value);
            return [entry.name, entry.type, entry.description || '', value].filter(Boolean).join(' — ');
        })
        .join('\n');
}

module.exports = { loadConfig, ConfigEnvironmentError, formatConfigReport };
