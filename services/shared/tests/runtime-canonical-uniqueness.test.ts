import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * AD-7: канонические цели и детекция libc живут только в services/shared/runtime/.
 * Скан запрещает дубли идиомов детекции и массивов из 8 канон-имён вне явного allowlist.
 * Тестовые фикстуры с glibcVersionRuntime как данными (не идиома чтения из отчёта) не считаются.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCAN_DIRECTORIES = ['services', 'scripts', 'mcp', 'frontend'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']);
const SKIP_ENTRIES = new Set(['node_modules', 'dist', 'bridge-dist', 'coverage', '.git', '.cache']);

const CANONICAL_TARGETS = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64-glibc',
    'linux-x64-glibc',
    'linux-arm64-musl',
    'linux-x64-musl',
    'win32-arm64',
    'win32-x64',
];

const GLIBC_DICTIONARY_ALLOWLIST = new Set([
    'services/shared/runtime/host-target.cjs',
    'scripts/catalog-plugins/python-runtime.mjs',
]);
const REPORT_CALL_ALLOWLIST = new Set(['services/shared/runtime/host-target.cjs']);
const CANONICAL_ARRAY_ALLOWLIST = new Set([
    'services/shared/runtime/targets.cjs',
    'services/shared/tests/runtime-targets.test.ts',
    'services/shared/tests/runtime-bridge-target.test.ts',
    'services/shared/tests/runtime-canonical-uniqueness.test.ts',
]);

const GLIBC_DICTIONARY = /getReport\s*\(\s*\)\s*\??\s*\.\s*header\s*\.\s*glibcVersionRuntime/;
const REPORT_CALL = /process\.report\.getReport\s*\(\s*\)/;

function relativeName(file: string): string {
    return path.relative(ROOT, file).split(path.sep).join('/');
}

function sourceFiles(): string[] {
    const files: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.startsWith('.run') || SKIP_ENTRIES.has(entry.name)) continue;
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
        }
    };
    for (const name of SCAN_DIRECTORIES) {
        const directory = path.join(ROOT, name);
        if (statSync(directory, { throwIfNoEntry: false })?.isDirectory()) walk(directory);
    }
    return files;
}

/** Балансированные срезы [ ... ] (эвристика; allowlist явный и валидирован прогоном). */
function arrayRegions(text: string): string[] {
    const regions: string[] = [];
    let depth = 0;
    let start = -1;
    for (let index = 0; index < text.length; index += 1) {
        const ch = text[index];
        if (ch === '[') {
            if (depth === 0) start = index;
            depth += 1;
        } else if (ch === ']' && depth > 0) {
            depth -= 1;
            if (depth === 0 && start >= 0) regions.push(text.slice(start, index + 1));
        }
    }
    return regions;
}

test('Идиома чтения glibcVersionRuntime из отчёта — только в каноне и allowlist', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
        const name = relativeName(file);
        if (GLIBC_DICTIONARY.test(readFileSync(file, 'utf8')) && !GLIBC_DICTIONARY_ALLOWLIST.has(name))
            offenders.push(name);
    }
    assert.deepEqual(offenders.sort(), []);
});

test('process.report: вызов getReport() — только в каноне host-target.cjs', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
        const name = relativeName(file);
        if (REPORT_CALL.test(readFileSync(file, 'utf8')) && !REPORT_CALL_ALLOWLIST.has(name)) offenders.push(name);
    }
    assert.deepEqual(offenders.sort(), []);
});

test('Массивы со всеми 8 канон-именами — только в каноне и его тестах', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
        const name = relativeName(file);
        if (CANONICAL_ARRAY_ALLOWLIST.has(name)) continue;
        const hasFullArray = arrayRegions(readFileSync(file, 'utf8')).some((region) =>
            CANONICAL_TARGETS.every((target) => region.includes(`'${target}'`) || region.includes(`"${target}"`)),
        );
        if (hasFullArray) offenders.push(name);
    }
    assert.deepEqual(offenders.sort(), []);
});
