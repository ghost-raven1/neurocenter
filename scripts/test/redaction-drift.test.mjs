/**
 * 6.7 (AD-O8): redaction drift-тест — allowlist error-полей в логах + nginx m/:ticket.
 *
 * node --test scripts/test/redaction-drift.test.mjs
 *
 * Покрывает:
 * 1. Passthrough error-полей в log-вызовах в src всех сервисов (services/) = 0:
 *    `<error>.message`,
 *    `<error>.stack` (включая cast-форму `(error as T).message`) и `String(<error>)`
 *    в аргументах вызовов console/log/logger/Logger — fail с файлом:строкой.
 *    Allowlist AD-O8 = name/code/causeCode: его применяет shared-логгер (6.6) к
 *    полю `err`, поэтому в src остаётся только `log.error('msg', { err })`.
 *    Исключения (allowlist файлов): *.cli.ts, тесты (*.test.ts/*.spec.ts, каталог tests/).
 * 2. Nginx-шаблон (статически, без live-стека): top-level `map $uri $masked_uri`
 *    с regex-правилом m/:ticket → /api/mcp-host/m/REDACTED и `default $uri`;
 *    log_format neurocenter пишет "path":"$masked_uri" (не сырой $uri) и
 *    сохраняет "requestId":"$request_id" (correlation, entry 6). Маска
 *    симулируется по извлечённым правилам template'а — edge-матрица AD-O8
 *    (m/:ticket и пустой m/ маскируются, остальные пути нет).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Названия лог-методов, которые пишут в log. */
const LOG_METHODS = '(?:log|error|warn|info|debug|fatal|trace)';
/** Точки log-вызовов: console.*, (this.)log.*, (this.)logger.*, Logger.* (Nest). */
const CALL_SITES = new RegExp(
    [
        `\\bconsole\\.${LOG_METHODS}\\s*\\(`,
        `\\b(?:this\\.)?(?:log|logger)\\.${LOG_METHODS}\\s*\\(`,
        `\\bLogger\\.${LOG_METHODS}\\s*\\(`,
    ].join('|'),
    'g',
);
/**
 * Passthrough error-полей: receiver = error/err/e (с опциональным cast `as T`),
 * доступ .message/.stack; либо String(error|err|e).
 */
const PASSTHROUGH = [
    /(?:(?:error|err|e)\s+as\s+[^)\n]*\)|\b(?:error|err|e)\b)\s*\??\.(?:message|stack)\b/,
    /\bString\(\s*\b(?:error|err|e)\b\s*\)/,
];

/** Аргументы вызова от открывающей скобки до пары закрывающей (строки/шаблоны учитываются). */
function captureCallArgs(source, openParenIndex) {
    let depth = 0;
    for (let i = openParenIndex; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === "'" || ch === '"') {
            i += 1;
            while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1;
            continue;
        }
        if (ch === '`') {
            i += 1;
            while (i < source.length && source[i] !== '`') {
                if (source[i] === '\\') i += 1;
                else if (source[i] === '$' && source[i + 1] === '{') {
                    let templateDepth = 1;
                    i += 2;
                    while (i < source.length && templateDepth > 0) {
                        if (source[i] === '{') templateDepth += 1;
                        else if (source[i] === '}') templateDepth -= 1;
                        i += 1;
                    }
                    i -= 1;
                }
                i += 1;
            }
            continue;
        }
        if (ch === '(') depth += 1;
        else if (ch === ')') {
            depth -= 1;
            if (depth === 0) return source.slice(openParenIndex + 1, i);
        }
    }
    return source.slice(openParenIndex + 1);
}

/** Удаляет блок- и //-комментарии (кроме :// в URL), чтобы комментарии не считались drift. */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(?<!:)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

/** Статический поиск passthrough в аргументах log-вызовов файла; возвращает file:line. */
function findPassthrough(rel, source) {
    const stripped = stripComments(source);
    const offenders = [];
    CALL_SITES.lastIndex = 0;
    let match;
    while ((match = CALL_SITES.exec(stripped)) !== null) {
        const openParen = stripped.indexOf('(', match.index + match[0].length - 1);
        const args = captureCallArgs(stripped, openParen);
        if (PASSTHROUGH.some((pattern) => pattern.test(args))) {
            offenders.push(`${rel}:${lineOf(stripped, match.index)}`);
        }
    }
    return offenders;
}

test('drift AD-O8: passthrough error.message/stack/String(error) в log-вызовах services/*/src = 0', async () => {
    const servicesDir = path.join(root, 'services');
    const services = await readdir(servicesDir);
    let checked = 0;
    const offenders = [];
    for (const svc of services) {
        const srcDir = path.join(servicesDir, svc, 'src');
        const st = await stat(srcDir).catch(() => null);
        if (!st || !st.isDirectory()) continue;
        for await (const file of walkTs(srcDir)) {
            const name = path.basename(file);
            const rel = path.relative(root, file);
            if (
                name.endsWith('.cli.ts') ||
                name.endsWith('.test.ts') ||
                name.endsWith('.spec.ts') ||
                rel.split(path.sep).includes('tests')
            )
                continue;
            checked += 1;
            offenders.push(...findPassthrough(rel, await readFile(file, 'utf8')));
        }
    }
    assert.ok(checked > 100, `проверено файлов: ${checked} — подозрительно мало`);
    assert.deepEqual(offenders, [], `error-passthrough в log-вызовах (вне allowlist): ${offenders.join(', ')}`);
});

test('AD-O8: nginx-шаблон — map $uri $masked_uri, log_format пишет $masked_uri, $request_id сохранён', async () => {
    const template = await readFile(path.join(root, 'frontend', 'nginx.production.conf.template'), 'utf8');

    const mapBlock = template.match(/map\s+\$uri\s+\$masked_uri\s*\{([\s\S]*?)\n\}/);
    assert.ok(mapBlock, 'map $uri $masked_uri не найден (top-level http-контекст)');
    assert.match(mapBlock[1], /default\s+\$uri\s*;/, 'map обязан иметь default $uri');

    const rule = mapBlock[1].match(/~\s*([^;\s]+)\s+([^;\s]+)\s*;/);
    assert.ok(rule, 'regex-правило маскировки m/:ticket не найдено');
    assert.equal(rule[1], '^/api/mcp-host/m/', 'маскируется весь путь после m/ (без якоря конца — перемаскируем, а не пропустим)');
    assert.equal(rule[2], '/api/mcp-host/m/REDACTED', 'фиксированная маска (билет в логах нет)');

    const logFormat = template.match(/log_format\s+neurocenter[^;]*;/);
    assert.ok(logFormat, 'log_format neurocenter не найден');
    assert.match(logFormat[0], /"path":"\$masked_uri"/, 'log_format обязан писать $masked_uri');
    assert.ok(!template.includes('"path":"$uri"'), 'log_format снова пишет сырой $uri');
    assert.match(logFormat[0], /"requestId":"\$request_id"/, '$request_id удалён из log_format (correlation, entry 6)');
});

test('AD-O8: маска из nginx-шаблона — edge-матрица (m/:ticket и пустой m/ маскируются, остальные пути нет)', async () => {
    const template = await readFile(path.join(root, 'frontend', 'nginx.production.conf.template'), 'utf8');
    const mapBlock = template.match(/map\s+\$uri\s+\$masked_uri\s*\{([\s\S]*?)\n\}/);
    assert.ok(mapBlock, 'map $uri $masked_uri не найден');
    const rule = mapBlock[1].match(/~\s*([^;\s]+)\s+([^;\s]+)\s*;/);
    assert.ok(rule, 'regex-правило маскировки не найдено');
    const maskPattern = new RegExp(rule[1]);
    const loggedPath = (uri) => (maskPattern.test(uri) ? rule[2] : uri);

    // Кас 3: билет маскируется, сырой ticket в строке лога нет.
    const ticket = 'eyJhbGciOiJub25lIn0.c2VjcmV0LXRpY2tldA';
    const masked = loggedPath('/api/mcp-host/m/' + ticket);
    assert.equal(masked, '/api/mcp-host/m/REDACTED');
    assert.ok(!masked.includes(ticket), 'CRIT: сырой билет остался в лог-пути');
    // Кас 8: пустой ticket (m/ без сегмента) — тоже маска.
    assert.equal(loggedPath('/api/mcp-host/m/'), '/api/mcp-host/m/REDACTED');
    // Кас 4/5: остальные пути не трогаются.
    assert.equal(loggedPath('/api/projects/123'), '/api/projects/123');
    assert.equal(loggedPath('/socket.io/'), '/socket.io/');
    assert.equal(loggedPath('/api/mcp-host/m'), '/api/mcp-host/m');
    assert.equal(loggedPath('/api/mcp-host/connect'), '/api/mcp-host/connect');
});

async function* walkTs(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walkTs(full);
        else if (entry.name.endsWith('.ts')) yield full;
    }
}
