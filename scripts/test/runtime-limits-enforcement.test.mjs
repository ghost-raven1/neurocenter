/**
 * AD-1/AD-9/AD-12 (epic-res-obs entry 4): двухуровневые лимиты — enforcement-точки + инварианты.
 *
 * Модель (AD-1): ceiling — константа в едином источнике (RUNTIME_LIMIT_CEILINGS,
 * services/shared/runtime-limits.cjs), политика — default ≤ policy ≤ ceiling
 * (DB runtime_limit_settings). P0-RES (R11): у каждого заявленного лимита есть
 * enforcement-точка; лимит, который не работает, — дефект.
 *
 * Проверки (таблица и allowlist'ы — единый источник services/shared/runtime-limit-enforcement.cjs):
 *
 *  1. Completeness: каждая секция RUNTIME_LIMIT_CEILINGS имеет запись в таблице
 *     «секция → enforcement-точка (файл+символ+маркер) → тест»: файл точки существует
 *     и содержит символ и маркер применения политики, тест-файл существует.
 *     Data-driven: набор секций — из единого источника, не хардкод — новая секция
 *     (epic 2/5) подхватывается АВТОМАТИЧЕСКИ: без записи = фэйл с именем секции.
 *     Исключение — только явный allowlist ENFORCEMENT_EXEMPTIONS с причиной.
 *  2. Анти-гниение таблицы: запись на несуществующую секцию = фэйл.
 *  3. Инвариант ceiling > default: попарно для каждой секции/поля (numeric).
 *     ceiling < default = фэйл; новое вырождение (ceiling == default вне allowlist)
 *     = фэйл с именем секции/поля; allowlisted (Deferred по AD-1) = флаг, не фэйл.
 *     Протухшая запись Deferred-allowlist = фэйл.
 *  4. AD-12: локальных ceiling-литералов в сервисных бинариях нет: значения
 *     отличительных ceiling (≥ 128 KiB, кроме Int32-max) в КОДЕ src всех сервисов
 *     (строковые/комментарные/regex-литералы исключены; test-файлы и fixtures — тоже)
 *     обязаны иметь задокументированную запись CEILING_LITERAL_ALLOWLIST.
 *     Новое вхождение = фэйл; протухшая запись = фэйл.
 *  5. AD-1 env-прокси (gguf-секция): env-значение политики > default = fail-fast
 *     с именем переменной. Полный механизм fail-fast на старте — config-модуль
 *     сервиса (AD-9, epic-res-obs entry 5); здесь — правило модели лимитов.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sharedRequire = createRequire(path.join(root, 'services', 'shared', 'runtime-limits.cjs'));
const {
    ENFORCEMENT_POINTS,
    ENFORCEMENT_EXEMPTIONS,
    DEGENERATE_DEFERRED,
    CEILING_LITERAL_ALLOWLIST,
} = sharedRequire('./runtime-limit-enforcement.cjs');
const { RUNTIME_LIMIT_CEILINGS, DEFAULT_RUNTIME_LIMIT_POLICY } = sharedRequire('./runtime-limits.cjs');
const { DEFAULT_GGUF_IMPORT_POLICY, configuredGgufImportPolicy } = sharedRequire('./gguf-import-policy.cjs');

const rel = (file) => path.relative(root, file).split(path.sep).join('/');

/**
 * Copy исходника с обелёнными комментариями, строками, template и regex-литералами
 * (офсеты сохраняются) — чтобы ceiling-литералы в SQL-строках и комментариях
 * не считались кодом. Форма совпадает с guard'ом AD-8 (shared-declaration-drift).
 */
function blankNonCode(source) {
    const out = Array.from(source);
    const n = source.length;
    const blank = (from, to) => {
        for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
    };
    const regexPreceders = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '~']);
    const regexKeywords = new Set([
        'return',
        'typeof',
        'instanceof',
        'in',
        'of',
        'new',
        'delete',
        'void',
        'throw',
        'case',
        'do',
        'else',
    ]);
    const lastSignificant = (at) => {
        let k = at - 1;
        while (k >= 0 && /\s/.test(source[k])) k--;
        if (k < 0) return null;
        const ch = source[k];
        if (/[A-Za-z0-9_$]/.test(ch)) {
            let s = k;
            while (s > 0 && /[A-Za-z0-9_$]/.test(source[s - 1])) s--;
            return source.slice(s, k + 1);
        }
        return ch;
    };
    let i = 0;
    while (i < n) {
        const ch = source[i];
        const next = source[i + 1];
        if (ch === '/' && next === '/') {
            let j = i + 2;
            while (j < n && source[j] !== '\n') j++;
            blank(i, j);
            i = j;
        } else if (ch === '/' && next === '*') {
            let j = i + 2;
            while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
            j = Math.min(j + 2, n);
            blank(i, j);
            i = j;
        } else if (ch === "'" || ch === '"' || ch === '`') {
            let j = i + 1;
            while (j < n && source[j] !== ch) {
                if (source[j] === '\\') j++;
                j++;
            }
            j = Math.min(j + 1, n);
            blank(i, j);
            i = j;
        } else if (ch === '/') {
            const prev = lastSignificant(i);
            const regexStart = prev === null || regexPreceders.has(prev) || regexKeywords.has(prev);
            if (regexStart) {
                let j = i + 1;
                let inClass = false;
                let closed = false;
                while (j < n) {
                    const c = source[j];
                    if (c === '\n') break;
                    if (c === '\\') j++;
                    else if (c === '[') inClass = true;
                    else if (c === ']') inClass = false;
                    else if (c === '/' && !inClass) {
                        closed = true;
                        break;
                    }
                    j++;
                }
                if (closed) {
                    let k = j + 1;
                    while (k < n && 'gimsuyv'.includes(source[k])) k++;
                    blank(i, k);
                    i = k;
                    continue;
                }
            }
            i++;
        } else i++;
    }
    return out.join('');
}

/** Все сервисные src-файлы, кроме shared (единый источник), test-файлов и fixtures. */
function serviceSourceFiles() {
    const files = [];
    const visit = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'tests' || entry.name === 'test') continue;
                visit(full);
            } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name))
                files.push(full);
        }
    };
    for (const service of fs.readdirSync(path.join(root, 'services'))) {
        if (service === 'shared') continue;
        visit(path.join(root, 'services', service, 'src'));
    }
    return files;
}

/** Отличительные ceiling-значения: ≥ 128 KiB, кроме Int32-max (языковая константа). */
function distinctiveCeilingValues() {
    const values = new Set();
    for (const section of Object.values(RUNTIME_LIMIT_CEILINGS))
        for (const value of Object.values(section)) if (typeof value === 'number') values.add(value);
    return [...values].filter((value) => value >= 131072 && value !== 2147483647).sort((a, b) => a - b);
}

/** Стендовые формы N * 1024 ** P, где N — степень двойки (P ≥ 1). */
function ceilingExpressionForms() {
    const forms = [];
    for (const value of distinctiveCeilingValues()) {
        let base = value;
        let power = 0;
        while (base % 1024 === 0) {
            base /= 1024;
            power++;
        }
        if (power >= 1 && base >= 2 && (base & (base - 1)) === 0)
            forms.push({
                value,
                re: new RegExp(
                    `\\b${base}\\s*\\*\\s*1024${
                        power >= 2 ? `\\s*(\\*\\*|\\*)\\s*${power}(?!\\d)` : '(?!\\s*(\\*\\*|\\*)|\\s*[\\d.])'
                    }`,
                ),
            });
    }
    return forms;
}

/** Вхождения ceiling-литералов в коде файла (строки/комментарии/regex обелены). */
function ceilingLiteralHits(file) {
    const source = fs.readFileSync(file, 'utf8');
    const lines = blankNonCode(source).split('\n');
    const rawLines = source.split('\n');
    const hits = new Map(); // строка (0-based) → trimmed raw line
    for (const value of distinctiveCeilingValues()) {
        const re = new RegExp(`(?<![\\d.])${value}(?![\\d.])`);
        lines.forEach((line, index) => {
            if (re.test(line)) hits.set(index, rawLines[index].trim());
        });
    }
    for (const form of ceilingExpressionForms())
        lines.forEach((line, index) => {
            if (form.re.test(line)) hits.set(index, rawLines[index].trim());
        });
    return { file: rel(file), hits };
}

test('completeness: каждая секция RUNTIME_LIMIT_CEILINGS имеет enforcement-точку + тест', () => {
    const violations = [];
    const sections = Object.keys(RUNTIME_LIMIT_CEILINGS);
    assert.ok(sections.length > 0, 'RUNTIME_LIMIT_CEILINGS пуста — единый источник сломан');
    for (const section of sections) {
        const point = ENFORCEMENT_POINTS[section];
        const exemption = ENFORCEMENT_EXEMPTIONS[section];
        if (!point && !exemption) {
            violations.push(
                `секция ${section}: нет enforcement-точки — добавьте запись в ENFORCEMENT_POINTS ` +
                    `(файл+символ+маркер+тест) либо явное исключение ENFORCEMENT_EXEMPTIONS с причиной`,
            );
            continue;
        }
        if (point && exemption) {
            violations.push(`секция ${section}: и точка, и исключение — противоречие таблицы`);
            continue;
        }
        if (!point) {
            assert.ok(typeof exemption === 'string' && exemption.trim(), `исключение ${section} без причины`);
            continue;
        }
        const pointFile = path.join(root, point.file);
        if (!fs.existsSync(pointFile)) {
            violations.push(`секция ${section}: enforcement-файл не существует: ${point.file}`);
            continue;
        }
        const code = fs.readFileSync(pointFile, 'utf8');
        if (!code.includes(point.symbol))
            violations.push(`секция ${section}: символ ${point.symbol} не найден в ${point.file} (точка сгнила?)`);
        if (!code.includes(point.marker))
            violations.push(
                `секция ${section}: маркер применения политики '${point.marker}' не найден в ${point.file} ` +
                    '(точка не применяет политику?)',
            );
        if (!/\.test\.(ts|tsx|mjs|cjs)$/.test(point.test))
            violations.push(`секция ${section}: тест '${point.test}' не похож на тест-файл`);
        else if (!fs.existsSync(path.join(root, point.test)))
            violations.push(`секция ${section}: тест-файл не существует: ${point.test}`);
    }
    assert.deepEqual(violations, [], 'completeness enforcement-точек: ' + violations.join('\n  '));
});

test("анти-гниение: записи таблицы и allowlist'ов ссылаются только на живые секции/поля", () => {
    const violations = [];
    for (const section of Object.keys(ENFORCEMENT_POINTS))
        if (!Object.hasOwn(RUNTIME_LIMIT_CEILINGS, section))
            violations.push(`ENFORCEMENT_POINTS.${section}: секции нет в RUNTIME_LIMIT_CEILINGS (протухшая запись?)`);
    for (const section of Object.keys(ENFORCEMENT_EXEMPTIONS))
        if (!Object.hasOwn(RUNTIME_LIMIT_CEILINGS, section))
            violations.push(`ENFORCEMENT_EXEMPTIONS.${section}: секции нет в RUNTIME_LIMIT_CEILINGS (протухшая запись?)`);
    for (const key of Object.keys(DEGENERATE_DEFERRED)) {
        const [section, field] = key.split('.');
        if (!Object.hasOwn(RUNTIME_LIMIT_CEILINGS, section) || typeof RUNTIME_LIMIT_CEILINGS[section]?.[field] !== 'number')
            violations.push(`DEGENERATE_DEFERRED.${key}: поля нет в RUNTIME_LIMIT_CEILINGS (протухшая запись?)`);
        if (!typeof DEFAULT_RUNTIME_LIMIT_POLICY[section]?.[field] === 'number')
            violations.push(`DEGENERATE_DEFERRED.${key}: default-поля нет в DEFAULT_RUNTIME_LIMIT_POLICY`);
    }
    const allowlistKeys = new Set();
    for (const entry of CEILING_LITERAL_ALLOWLIST) {
        if (!fs.existsSync(path.join(root, entry.file)))
            violations.push(`CEILING_LITERAL_ALLOWLIST: файл не существует: ${entry.file}`);
        const identity = entry.file + '\u0000' + entry.line;
        if (allowlistKeys.has(identity)) violations.push(`CEILING_LITERAL_ALLOWLIST: дублирующая запись: ${identity}`);
        allowlistKeys.add(identity);
        if (!entry.reason.trim()) violations.push(`CEILING_LITERAL_ALLOWLIST: запись без причины: ${identity}`);
    }
    assert.deepEqual(violations, [], 'анти-гниение таблицы: ' + violations.join('\n  '));
});

test('инвариант ceiling > default: новое вырождение = фэйл, Deferred-вырождение = флаг', () => {
    const violations = [];
    const flags = [];
    for (const [section, ceilings] of Object.entries(RUNTIME_LIMIT_CEILINGS)) {
        const defaults = DEFAULT_RUNTIME_LIMIT_POLICY[section];
        assert.ok(defaults, `секция ${section} отсутствует в DEFAULT_RUNTIME_LIMIT_POLICY`);
        for (const [field, ceiling] of Object.entries(ceilings)) {
            const defaultValue = defaults[field];
            if (typeof ceiling !== 'number' || typeof defaultValue !== 'number') continue;
            const key = section + '.' + field;
            if (ceiling < defaultValue)
                violations.push(`${key}: ceiling ${ceiling} < default ${defaultValue} — модель сломана`);
            if (ceiling === defaultValue) {
                if (Object.hasOwn(DEGENERATE_DEFERRED, key))
                    flags.push(`${key}: ceiling == default == ${ceiling} — ${DEGENERATE_DEFERRED[key]}`);
                else
                    violations.push(
                        `${key}: вырожденная секция (ceiling == default == ${ceiling}) вне Deferred-allowlist — ` +
                            'либо финализируйте значения (релиз контракта), либо внесите в DEGENERATE_DEFERRED с причиной',
                    );
            } else if (Object.hasOwn(DEGENERATE_DEFERRED, key)) {
                flags.push(`${key}: ${DEGENERATE_DEFERRED[key]}`);
            }
        }
    }
    assert.deepEqual(violations, [], 'инвариант ceiling > default: ' + violations.join('\n  '));
    for (const flag of flags) console.log(`[deferred] ${flag}`);
    assert.equal(flags.length, Object.keys(DEGENERATE_DEFERRED).length, 'не все Deferred-записи дали флаг');
});

test('AD-12: ceiling-литералы в сервисных бинариях только через shared-ре-экспорт', () => {
    const violations = [];
    const usedAllowlist = new Set();
    for (const file of serviceSourceFiles()) {
        const { file: relPath, hits } = ceilingLiteralHits(file);
        for (const [index, line] of hits) {
            const entry = CEILING_LITERAL_ALLOWLIST.findIndex(
                (candidate) => candidate.file === relPath && candidate.line === line,
            );
            if (entry === -1) {
                violations.push(
                    `${relPath}:${Number(index) + 1}: локальный ceiling-литерал — ceiling-значения только из ` +
                        `единого источника (services/shared); либо используйте re-export, либо внесите запись ` +
                        `CEILING_LITERAL_ALLOWLIST с причиной: ${line}`,
                );
            } else usedAllowlist.add(entry);
        }
    }
    for (const [index, entry] of CEILING_LITERAL_ALLOWLIST.entries())
        if (!usedAllowlist.has(index))
            violations.push(
                `CEILING_LITERAL_ALLOWLIST[${index}]: протухшая запись (строка больше не встречается): ` +
                    `${entry.file}: ${entry.line}`,
            );
    assert.deepEqual(violations, [], 'AD-12 ceiling-литералы: ' + violations.join('\n  '));
});

test('AD-1: env-значение gguf-политики > default = fail-fast (прокси для config-модуля)', () => {
    const env = (value) => ({ GGUF_IMPORT_POLICY_JSON: JSON.stringify(value) });
    // Выше дефолта — fail-fast с именем переменной.
    for (const [field, over] of [
        ['maximumBytes', DEFAULT_GGUF_IMPORT_POLICY.maximumBytes + 1],
        ['storageQuotaBytes', DEFAULT_GGUF_IMPORT_POLICY.storageQuotaBytes * 2],
    ]) {
        assert.throws(
            () => configuredGgufImportPolicy(env({ [field]: over })),
            (error) =>
                error instanceof Error && /GGUF_IMPORT_POLICY_JSON\./s.test(error.message) && error.message.includes(field),
            `env ${field} > default не дал fail-fast с именем переменной`,
        );
    }
    // Ровно дефолт и ниже дефолта — допустимый bootstrap.
    assert.doesNotThrow(() =>
        configuredGgufImportPolicy(env({ maximumBytes: DEFAULT_GGUF_IMPORT_POLICY.maximumBytes })),
    );
    assert.doesNotThrow(() =>
        configuredGgufImportPolicy(env({ maximumBytes: Math.max(1, DEFAULT_GGUF_IMPORT_POLICY.maximumBytes / 2) })),
    );
    // Неизвестное поле и некорректный JSON по-прежнему отклоняются валидацией политики.
    assert.throws(() => configuredGgufImportPolicy(env({ bogus: 1 })));
    assert.throws(() => configuredGgufImportPolicy({ GGUF_IMPORT_POLICY_JSON: '{не json' }));
    // Без env — дефолтная политика (bootstrap не меняет значений).
    assert.deepEqual(configuredGgufImportPolicy({}), DEFAULT_GGUF_IMPORT_POLICY);
});
