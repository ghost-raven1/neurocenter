/**
 * AD-8 drift-guard: .cjs ↔ .d.cts declarations in services/shared and TARGETS canon copies (AD-7).
 *
 * Both sides are parsed statically — no require/import of shared .cjs modules (10 of 80 read
 * env/secret files at import time, 2 throw at import). The single require is the canon
 * runtime/targets.cjs (clean import, verified). Unsupported export forms fail loudly, never pass silently.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sharedDir = path.join(root, 'services', 'shared');
const requireCanon = createRequire(import.meta.url);
const { TARGETS, BRIDGE_TARGETS, toBridgeTarget } = requireCanon(path.join(sharedDir, 'runtime', 'targets.cjs'));

/** Worker does its job at import and throws; it has no exports, no declaration. */
const NO_DECL_ALLOWLIST = ['chat-document-worker.cjs'];
/** Type-only receipts without a runtime module. */
const DECL_ONLY_ALLOWLIST = ['services/shared/gguf-import.d.ts'];
/** Dual-format shim (.cjs -> .mjs) keeps both declaration sides. */
const DUP_PAIR_ALLOWLIST = ['skill-source'];
/** Standalone copies of the canonical target list (AD-7); after 1.6 device-report.ts and
 * runtimeArtifacts.ts import the canon directly, so they are not standalone copies. */
const TARGETS_COPIES = [
    'frontend/src/modules/Store/packaging/platformLabels.ts',
    'frontend/src/modules/Store/installPlans/RuntimeArtifactsDetails.tsx',
    'services/shared/tool-runtime-source.d.cts',
    'services/shared/runtime/targets.d.cts',
];

const rel = (file) => path.relative(root, file).split(path.sep).join('/');

class Unsupported extends Error {}
const unsupported = (file, detail) =>
    new Unsupported(`${rel(file)}: неподдерживаемая форма экспорта (${detail}) — обновите guard или форму экспорта.`);

/** Same-length copy of source with comment and string/template/regex literal bodies blanked (offsets preserved). */
function blankNonCode(source, { blankStrings }) {
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
            if (blankStrings) blank(i, j);
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

function walkShared() {
    const out = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'tests' || entry.name === 'node_modules') continue;
                visit(file);
            } else out.push(file);
        }
    };
    visit(sharedDir);
    return out;
}

/** Split a module.exports object body at top-level commas, respecting strings and nesting. */
function splitTopLevel(span) {
    const parts = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    while (i < span.length) {
        const ch = span[i];
        if (ch === '"' || ch === "'") {
            const quote = ch;
            i++;
            while (i < span.length && span[i] !== quote) {
                if (span[i] === '\\') i++;
                i++;
            }
        } else if (ch === '`') {
            i++;
            while (i < span.length && span[i] !== '`') {
                if (span[i] === '\\') i++;
                i++;
            }
        } else if (ch === '/' && span[i + 1] === '/') {
            while (i < span.length && span[i] !== '\n') i++;
        } else if (ch === '/' && span[i + 1] === '*') {
            i += 2;
            while (i < span.length && !(span[i] === '*' && span[i + 1] === '/')) i++;
            i++;
        } else if ('({['.includes(ch)) depth++;
        else if ('}])'.includes(ch)) depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(span.slice(start, i));
            start = i + 1;
        }
        i++;
    }
    parts.push(span.slice(start));
    return parts.map((part) => part.trim()).filter(Boolean);
}

function parseObjectEntries(source, code, at) {
    const open = code.indexOf('{', at);
    if (open < 0) throw unsupported(source, 'module.exports без объекта');
    let depth = 0;
    let close = -1;
    for (let k = open; k < code.length; k++) {
        if (code[k] === '{') depth++;
        else if (code[k] === '}') {
            depth--;
            if (depth === 0) {
                close = k;
                break;
            }
        }
    }
    if (close < 0) throw unsupported(source, 'незакрытый объект module.exports');
    const entries = [];
    for (const part of splitTopLevel(source.slice(open + 1, close))) {
        let match;
        if (part.startsWith('[')) throw unsupported(source, 'вычисленный ключ в module.exports');
        if (part.startsWith('...')) throw unsupported(source, 'spread в module.exports');
        if ((match = part.match(/^(['"])([^'"]+)\1\s*:\s*([\s\S]*)$/)))
            entries.push({ name: match[2], valueText: match[3].trim() });
        else if ((match = part.match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([\s\S]*))?$/)))
            entries.push({ name: match[1], valueText: (match[2] ?? '').trim() });
        else throw unsupported(source, `нераспознанный entry: ${part.slice(0, 60)}`);
    }
    return entries;
}

/** Parse shared .cjs exports statically. Forms: object literal, require-shim, ident, incremental exports.x. */
function parseCjsModule(file) {
    const source = fs.readFileSync(file, 'utf8');
    const code = blankNonCode(source, { blankStrings: true });
    const assignments = [...code.matchAll(/\bmodule\s*\.\s*exports\s*(?:\.\s*([A-Za-z_$][\w$]*))?\s*=/g)];
    if (assignments.some((match) => match[1])) throw unsupported(file, 'module.exports.x = ...');
    const whole = assignments.filter((match) => !match[1]);
    if (whole.length > 1) throw unsupported(file, 'несколько присваиваний module.exports');
    const incremental = [...code.matchAll(/\bexports\s*\.\s*([A-Za-z_$][\w$]*)\s*=/g)].map((match) => match[1]);
    if (whole.length && incremental.length)
        throw unsupported(file, 'module.exports = ... и exports.x = ... одновременно');
    if (whole.length === 0 && incremental.length === 0) return { kind: 'empty' };
    if (whole.length === 0) {
        const entries = [];
        for (const name of new Set(incremental)) {
            const match = code.match(
                new RegExp(`\\bexports\\s*\\.\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*=`),
            );
            const value = source.slice(match.index + match[0].length).replace(/^\s+/, '');
            entries.push({ name, valueText: value });
        }
        return { kind: 'incremental', entries };
    }
    const at = whole[0].index + whole[0][0].length;
    const rest = code.slice(at).replace(/^\s+/, '');
    const restRaw = source.slice(at).replace(/^\s+/, '');
    if (rest.startsWith('{')) return { kind: 'object', entries: parseObjectEntries(source, code, whole[0].index) };
    const shim = restRaw.match(/^require\(\s*(['"])([^'"]+)\1\s*\)/);
    if (shim) return { kind: 'shim', target: shim[2] };
    const ident = rest.match(/^([A-Za-z_$][\w$]*)(?=[\s;]|$)/);
    if (ident) return { kind: 'default', ident: ident[1] };
    throw unsupported(file, `module.exports = ${restRaw.slice(0, 60)}`);
}

/** Top-level declaration form of a name in a .cjs: function, class, module (require) or value. */
function topLevelBinding(code, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^(?:async\\s+)?function\\s+${esc}\\s*\\(`, 'm').test(code)) return 'function';
    if (new RegExp(`^class\\s+${esc}\\b`, 'm').test(code)) return 'class';
    const binding = code.match(new RegExp(`^(?:const|let|var)\\s+${esc}\\s*=\\s*`, 'm'));
    if (!binding) return undefined;
    const rest = code.slice(binding.index + binding[0].length).replace(/^\s+/, '');
    if (/^(?:async\s+)?\(/.test(rest) || /^(?:async\s+)?function\b/.test(rest)) return 'function';
    if (rest.startsWith('class')) return 'class';
    if (rest.startsWith('require(')) return 'module';
    return 'value';
}

/** Runtime form of one export entry: function, class, module, value or undefined (not resolvable). */
function resolveExportForm(code, name, valueText) {
    const text = valueText.trim();
    if (text === '') return topLevelBinding(code, name);
    if (/^(?:async\s+)?\(/.test(text) || /^(?:async\s+)?function\b/.test(text)) return 'function';
    if (text.startsWith('class')) return 'class';
    if (text.startsWith('require(')) return 'module';
    if (/^[A-Za-z_$][\w$]*$/.test(text)) return topLevelBinding(code, text);
    return 'value';
}

/** Named ESM exports of a .mjs target of a CJS re-export shim (static, no import). */
function parseEsmExports(file) {
    const code = blankNonCode(fs.readFileSync(file, 'utf8'), { blankStrings: true });
    const names = new Set();
    for (const match of code.matchAll(/\bexport\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g))
        names.add(match[1]);
    for (const match of code.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
    if (/\bexport\s+default\b/.test(code)) names.add('default');
    for (const match of code.matchAll(/\bexport\s*\{([\s\S]*?)\}/g))
        for (const item of match[1].split(',')) {
            const part = item.trim().replace(/^type\s+/, '');
            if (part)
                names.add(
                    part
                        .split(/\s+as\s+/)
                        .pop()
                        .trim(),
                );
        }
    return names;
}

/** Named exports of a .d.cts/.d.ts/.d.mts: value declarations with form, type-only names, default flag. */
function parseDeclarations(file) {
    const code = blankNonCode(fs.readFileSync(file, 'utf8'), { blankStrings: true });
    const decls = new Map();
    let hasDefault = false;
    const push = (name, kind, form = 'other') => {
        const current = decls.get(name);
        if (current && current.kind !== kind) throw unsupported(file, `${name} объявлен в двух формах`);
        if (!current) decls.set(name, { kind, form });
    };
    const known =
        /\bexport\s+(?:declare\s+)?(?:default\b|async\s+function\b|function\b|class\b|const\b|let\b|var\b|interface\b|type\b|enum\b)|(?:^|[^.\w$])export\s+(?:type\s+)?\{|(?:^|[^.\w$])export\s*=/;
    for (const match of code.matchAll(/\bexport\b/g)) {
        if (!known.test(code.slice(match.index, match.index + 120)))
            throw unsupported(
                file,
                `нераспознанный синтаксис export: ${code.slice(match.index, match.index + 40).trim()}`,
            );
    }
    for (const match of code.matchAll(
        /\bexport\s+(?:declare\s+)?(default|async\s+function|function|class|const|let|var|interface|type|enum)\b/g,
    )) {
        const keyword = match[1];
        if (keyword === 'default') {
            hasDefault = true;
            continue;
        }
        const nameMatch = code.slice(match.index + match[0].length).match(/^\s*([A-Za-z_$][\w$]*)/);
        if (!nameMatch) throw unsupported(file, `export ${keyword} без имени`);
        const name = nameMatch[1];
        const after = code.slice(match.index + match[0].length + nameMatch[0].length).replace(/^\s+/, '');
        if (keyword === 'async function' || keyword === 'function') push(name, 'value', 'function');
        else if (keyword === 'class') push(name, 'value', 'class');
        else if (keyword === 'enum') push(name, 'value', 'enum');
        else if (keyword === 'interface' || keyword === 'type') push(name, 'type');
        else {
            if (after.startsWith(',')) throw unsupported(file, 'несколько имён в одном export const');
            push(name, 'value', 'const');
        }
    }
    for (const match of code.matchAll(/\bexport\s+(type\s+)?\{([\s\S]*?)\}/g)) {
        for (const item of match[2].split(',')) {
            const part = item.trim();
            if (!part) continue;
            const isType = Boolean(match[1]) || part.startsWith('type ');
            const bare = part.replace(/^type\s+/, '');
            push(
                bare
                    .split(/\s+as\s+/)
                    .pop()
                    .trim(),
                isType ? 'type' : 'value',
                'other',
            );
        }
    }
    return { decls, hasDefault };
}

/** Bidirectional drift between one .cjs and its .d.cts: names, type-only hygiene, conservative forms. */
function checkPair(cjsFile, dctsFile) {
    const violations = [];
    const cjs = parseCjsModule(cjsFile);
    const code = blankNonCode(fs.readFileSync(cjsFile, 'utf8'), { blankStrings: true });
    let expNames;
    const expForms = new Map();
    if (cjs.kind === 'shim') {
        const target = path.resolve(path.dirname(cjsFile), cjs.target);
        if (!fs.existsSync(target)) return [`shim ${JSON.stringify(cjs.target)}: цель не найдена рядом с .cjs`];
        expNames = parseEsmExports(target);
    } else if (cjs.kind === 'incremental') {
        expNames = new Set(cjs.entries.map((entry) => entry.name));
        for (const entry of cjs.entries) expForms.set(entry.name, resolveExportForm(code, entry.name, entry.valueText));
    } else if (cjs.kind === 'object') {
        expNames = new Set(cjs.entries.map((entry) => entry.name));
        for (const entry of cjs.entries) expForms.set(entry.name, resolveExportForm(code, entry.name, entry.valueText));
    } else if (cjs.kind === 'default') {
        expNames = new Set(['default']);
    } else {
        expNames = new Set();
    }
    const { decls, hasDefault } = parseDeclarations(dctsFile);
    const valueDecls = [...decls.entries()].filter(([name, decl]) => name !== 'default' && decl.kind === 'value');
    const typeNames = new Set(
        [...decls.entries()].filter(([name, decl]) => name !== 'default' && decl.kind === 'type').map(([name]) => name),
    );
    if (cjs.kind === 'default' && !hasDefault)
        violations.push('module.exports = ident: в .d.cts ожидается export default');
    if (cjs.kind === 'default' && valueDecls.length)
        violations.push('module.exports = ident: именованные value-декларации недопустимы');
    if (cjs.kind !== 'default' && hasDefault) violations.push('export default в .d.cts при именованных module.exports');
    const overExport = [...expNames].filter((name) => name !== 'default' && !decls.has(name));
    const typeOnlyLeaks = [...expNames].filter((name) => name !== 'default' && typeNames.has(name));
    const overDecl = valueDecls.filter(([name]) => !expNames.has(name)).map(([name]) => name);
    if (overExport.length) violations.push(`экспортировано, но не декларировано: ${overExport.join(', ')}`);
    if (typeOnlyLeaks.length) violations.push(`type-only декларация runtime-экспорта: ${typeOnlyLeaks.join(', ')}`);
    if (overDecl.length) violations.push(`декларировано, но не экспортировано: ${overDecl.join(', ')}`);
    for (const [name, decl] of valueDecls) {
        const form = expForms.get(name);
        if (cjs.kind === 'shim' || form === undefined || form === 'value') continue;
        if (decl.form === 'function' && form !== 'function')
            violations.push(`${name}: декларировано как function, в .cjs форма ${form}`);
        if (decl.form === 'class' && form !== 'class')
            violations.push(`${name}: декларировано как class, в .cjs форма ${form}`);
    }
    return violations;
}

const sharedFiles = walkShared();
const cjsFiles = sharedFiles.filter((file) => file.endsWith('.cjs'));
const declFiles = sharedFiles.filter((file) => /\.(d\.cts|d\.ts|d\.mts)$/.test(file));

test('shared .cjs inventory is complete: 82 modules including the 1.6 runtime/ split', () => {
    assert.ok(cjsFiles.length >= 80, `неожиданное число .cjs: ${cjsFiles.length}`);
    assert.ok(
        cjsFiles.some((file) => file.endsWith('runtime/limits.cjs')),
        'runtime/limits.cjs (1.6) не найден',
    );
    assert.ok(
        cjsFiles.some((file) => file.endsWith('runtime/archive.cjs')),
        'runtime/archive.cjs (1.6) не найден',
    );
});

test('every shared .cjs has a .d.cts declaration or an explicit allowlist entry', () => {
    const violations = [];
    for (const file of cjsFiles) {
        if (fs.existsSync(file.replace(/\.cjs$/, '.d.cts'))) continue;
        if (NO_DECL_ALLOWLIST.includes(path.basename(file))) continue;
        violations.push(
            `${rel(file)}: нет декларации .d.cts — допишите декларацию или внесите файл в NO_DECL_ALLOWLIST с обоснованием`,
        );
    }
    assert.deepEqual(violations, []);
});

test('declarations match module.exports of every shared .cjs (names, type-only hygiene, conservative forms)', () => {
    const violations = [];
    for (const file of cjsFiles) {
        const declaration = file.replace(/\.cjs$/, '.d.cts');
        if (!fs.existsSync(declaration)) continue;
        try {
            for (const violation of checkPair(file, declaration)) violations.push(`${rel(file)}: ${violation}`);
        } catch (error) {
            if (error instanceof Unsupported) violations.push(error.message);
            else throw error;
        }
    }
    assert.deepEqual(violations, []);
});

test('declaration files are paired with a runtime module or explicitly allowlisted', () => {
    const violations = [];
    const byBase = new Map();
    for (const file of declFiles) {
        const base = file.replace(/\.(d\.cts|d\.ts|d\.mts)$/, '');
        byBase.set(base, [...(byBase.get(base) ?? []), file]);
    }
    for (const [base, list] of byBase) {
        const paths = list.map(rel);
        if (!fs.existsSync(base + '.cjs') && !fs.existsSync(base + '.mjs')) {
            if (list.every((file) => DECL_ONLY_ALLOWLIST.includes(rel(file)))) continue;
            violations.push(`${paths.join(', ')}: декларация без runtime-модуля — обоснуйте в DECL_ONLY_ALLOWLIST`);
        }
        if (list.length > 1 && !DUP_PAIR_ALLOWLIST.includes(path.basename(base)))
            violations.push(
                `${paths.join(', ')}: duplicate-pair деклараций одного модуля — обоснуйте в DUP_PAIR_ALLOWLIST`,
            );
    }
    assert.deepEqual(violations, []);
});

test('standalone TARGETS copies match the canonical runtime/targets.cjs', () => {
    const violations = [];
    const canon = new Set(TARGETS);
    for (const anchor of TARGETS_COPIES) {
        const file = path.join(root, anchor);
        if (!fs.existsSync(file)) {
            violations.push(`${anchor}: файл якоря не найден`);
            continue;
        }
        const code = blankNonCode(fs.readFileSync(file, 'utf8'), { blankStrings: false });
        const found = new Set();
        for (const match of code.matchAll(/(['"])([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\1/g)) found.add(match[2]);
        const extra = [...found].filter((target) => !canon.has(target));
        const missing = [...canon].filter((target) => !found.has(target));
        if (extra.length || missing.length)
            violations.push(
                `${anchor}: расхождение с каноном — лишние [${extra.join(', ')}], отсутствующие [${missing.join(', ')}]`,
            );
    }
    assert.deepEqual(violations, []);
});

test('BRIDGE_TARGETS is exactly the toBridgeTarget image of TARGETS (1.6 canon)', () => {
    assert.deepEqual([...BRIDGE_TARGETS].sort(), [...TARGETS].map((target) => toBridgeTarget(target)).sort());
});
