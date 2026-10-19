#!/usr/bin/env node
/** Проверяет настоящий локальный Ollama через MCP и LanceDB только в собственном временном проекте. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: {
    package: { type: 'string' }, url: { type: 'string' }, model: { type: 'string' },
    output: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
    console.log('node scripts/embedding/smoke-rag.mjs --package <готовый RAG-каталог> [--url http://127.0.0.1:11435/api] [--model qwen3-embedding:4b] [--output report.json] [--timeout-ms 300000]');
    process.exit(0);
}

const packageDirectory = await fs.realpath(path.resolve(values.package ?? path.join(repository, '.run/plugin-research/packed-readonly-rag')));
const endpoint = new URL(values.url ?? 'http://127.0.0.1:11435/api');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Smoke разрешает только локальный embedding-сервер.');
assert.equal(endpoint.protocol, 'http:', 'Для этого smoke нужен локальный HTTP endpoint.');
assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'Адрес не должен содержать учётные данные или параметры.');
assert.notEqual(endpoint.port, '11434', 'Smoke не использует глобальный Ollama на порту 11434.');
assert.equal(endpoint.pathname.replace(/\/+$/, ''), '/api', 'URL Ollama должен заканчиваться на /api.');
const model = values.model ?? 'qwen3-embedding:4b';
assert.ok(model.trim() && model.length <= 256 && !/[\x00-\x1f]/.test(model), 'Укажите модель эмбеддингов.');
const timeoutMs = Number(values['timeout-ms'] ?? 300_000);
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10_000 && timeoutMs <= 900_000, 'timeout-ms: целое число от 10000 до 900000.');
const deadline = Date.now() + timeoutMs;
const dimension = 2560;
const report = {
    status: 'running', model, endpoint: endpoint.href, dimension, node: process.versions.node,
    platform: process.platform, architecture: process.arch, checks: [],
    providerCalls: 0, vectorsValidated: 0, dimensionFaultResponses: 0, children: [],
    faultInjection: 'Собственный HTTP-прокси: HTTP 503 и укороченный ответ dimension probe.',
    indexingConnection: 'Прямой URL проектного runtime; профиль адаптера не подменяется тестом.',
    realProfileChanged: false, temporaryRemoved: false,
};
const check = name => report.checks.push(name);

/** Каждая фаза ограничена общим сроком; отдельный MCP-запрос ждём не более двух минут. */
async function bounded(promise, label, phaseMs = 120_000) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Истекло время: ${label}.`)), Math.max(1, Math.min(phaseMs, deadline - Date.now())));
        })]);
    } finally { clearTimeout(timer); }
}

/** Хэширует содержимое всего индекса, включая manifest, не загружая native LanceDB в процесс smoke. */
async function indexDigest(directory) {
    const hash = createHash('sha256');
    async function visit(current) {
        for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const filename = path.join(current, entry.name);
            assert.ok(!entry.isSymbolicLink(), 'В собственном индексе не ожидаются ссылки.');
            if (entry.isDirectory()) await visit(filename);
            else {
                assert.ok(entry.isFile(), 'В собственном индексе не ожидаются специальные файлы.');
                hash.update(path.relative(directory, filename)); hash.update('\0');
                hash.update(await fs.readFile(filename)); hash.update('\0');
            }
        }
    }
    await visit(directory);
    return hash.digest('hex');
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-embedding-rag-'));
const workspace = path.join(temporary, 'project');
const adapter = path.join(temporary, 'adapter');
const index = path.join(workspace, '.opencode', 'rag_db');
const workers = new Set();
const requests = new Set();
const canary = `own-smoke-error-${randomUUID()}`;
let mode = 'healthy';
let proxy;

try {
    const { Client } = await import(pathToFileURL(path.join(packageDirectory, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href);
    const { StdioClientTransport } = await import(pathToFileURL(path.join(packageDirectory, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href);
    await fs.access(path.join(packageDirectory, 'upstream/dist/core/config.js'));
    await fs.mkdir(workspace); await fs.mkdir(adapter);
    for (const name of ['upstream', 'node_modules']) {
        await fs.symlink(path.join(packageDirectory, name), path.join(adapter, name), process.platform === 'win32' ? 'junction' : 'dir');
    }
    for (const name of ['rag-mcp.mjs', 'rag-context.mjs', 'rag-errors.mjs', 'rag-local-runtime.mjs']) {
        await fs.copyFile(path.join(repository, 'scripts/catalog-plugins/recipes/adapters', name), path.join(adapter, name));
    }
    const config = JSON.stringify({
        indexing: { includeExtensions: ['.ts'] },
        retrieval: { minScore: 0, hybridSearch: { enabled: false } },
    }, null, 2) + '\n';
    await fs.writeFile(path.join(workspace, 'opencode-rag.json'), config);
    await fs.writeFile(path.join(workspace, 'recovery.ts'), [
        '/** Creates a password reset link when a user forgets a password. Создаёт ссылку восстановления доступа, если пользователь забыл пароль. */',
        'export function createPasswordResetLink(origin: string, token: string): string {',
        '    const link = new URL("/reset-password", origin);',
        '    link.searchParams.set("token", token);',
        '    return link.toString();',
        '}', '',
    ].join('\n'));
    await fs.writeFile(path.join(workspace, 'colors.ts'), [
        '/** Converts red, green and blue color channels to a hexadecimal color. */',
        'export function rgbToHex(red: number, green: number, blue: number): string {',
        '    return "#" + [red, green, blue].map(value => value.toString(16).padStart(2, "0")).join("");',
        '}', '',
    ].join('\n'));

    /** Передаёт только синтетические тексты собственных файлов настоящей проектной модели. */
    proxy = http.createServer(async (request, response) => {
        const controller = new AbortController(); requests.add(controller);
        response.once('close', () => { if (!response.writableFinished) controller.abort(); });
        try {
            assert.equal(request.method, 'POST'); assert.equal(request.url, '/api/embed');
            const chunks = []; let size = 0;
            for await (const chunk of request) {
                size += chunk.length; assert.ok(size <= 1024 * 1024, 'Слишком большой smoke-запрос.'); chunks.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString());
            assert.equal(body.model, model);
            report.providerCalls++;
            if (mode === 'unavailable') {
                response.writeHead(503, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: canary })); return;
            }
            const upstream = await fetch(endpoint.href.replace(/\/+$/, '') + '/embed', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.min(35_000, deadline - Date.now())))]),
            });
            assert.ok(upstream.ok, `Локальная модель вернула HTTP ${upstream.status}.`);
            const result = await upstream.json();
            const count = Array.isArray(body.input) ? body.input.length : 1;
            assert.equal(result.embeddings?.length, count, 'Число векторов не совпало с числом текстов.');
            for (const vector of result.embeddings) {
                assert.ok(Array.isArray(vector) && vector.length === dimension && vector.every(Number.isFinite), 'Модель должна возвращать 2560 конечных координат.');
                assert.ok(vector.some(value => value !== 0), 'Модель вернула нулевой вектор.');
                report.vectorsValidated++;
            }
            if (mode === 'wrong-dimension') {
                result.embeddings = result.embeddings.map(vector => vector.slice(0, -1)); report.dimensionFaultResponses++;
            }
            response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
        } catch (error) {
            report.proxyError = error instanceof Error ? error.message : 'Ошибка локальной модели.';
            if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'Локальная модель не выполнила smoke-запрос.' }));
        } finally { requests.delete(controller); }
    });
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}/api`;

    /** Native библиотеки живут только в дочернем MCP; SDK завершает его с ограниченным ожиданием. */
    async function startWorker(baseUrl, phase) {
        const client = new Client({ name: 'neurocenter-local-embedding-smoke', version: '1' });
        const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(adapter, 'rag-mcp.mjs')],
            cwd: workspace, stderr: 'pipe', env: {
                NEUROCENTER_RAG_EMBEDDING_PROVIDER: 'ollama', NEUROCENTER_RAG_EMBEDDING_URL: baseUrl,
                NEUROCENTER_RAG_EMBEDDING_MODEL: model, NEUROCENTER_RAG_EMBEDDING_KEY: '',
            } });
        const worker = { client, transport, stderr: '', closed: false }; workers.add(worker);
        transport.stderr.on('data', chunk => { worker.stderr = (worker.stderr + chunk).slice(-64 * 1024); });
        await bounded(client.connect(transport), 'MCP initialize', 30_000);
        worker.pid = transport.pid;
        assert.ok(Number.isSafeInteger(worker.pid) && worker.pid > 0, 'MCP не сообщил PID дочернего процесса.');
        worker.call = (name, args = {}) => bounded(client.callTool({ name, arguments: args }, undefined,
            { timeout: Math.max(1, Math.min(120_000, deadline - Date.now())) }), name);
        worker.stop = async () => {
            if (worker.closed) return;
            const pid = worker.pid;
            await bounded(client.close(), 'завершение MCP', 8_000).catch(() => transport.close());
            const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
            for (let attempt = 0; alive() && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
            if (alive()) { process.kill(pid, 'SIGKILL'); }
            for (let attempt = 0; alive() && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
            assert.ok(!alive(), 'Дочерний MCP не завершился.');
            worker.closed = true;
            assert.ok(!worker.stderr.includes(canary), 'Ответ провайдера попал в stderr MCP.');
            report.children.push({ phase, stopped: true }); workers.delete(worker);
        };
        return worker;
    }

    const successful = result => { assert.ok(!result.isError, JSON.stringify(result)); return result; };
    const jsonResult = result => JSON.parse(successful(result).content.find(item => item.type === 'text').text);
    const search = async (worker, query) => {
        const result = successful(await worker.call('search_semantic', { query, topK: 1 }));
        assert.match(JSON.stringify(result), /recovery\.ts/); assert.match(JSON.stringify(result), /createPasswordResetLink/);
    };
    const direct = await startWorker(endpoint.href.replace(/\/+$/, ''), 'direct');
    const tools = await bounded(direct.client.listTools(), 'listTools', 10_000);
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['search_semantic', 'get_file_skeleton', 'find_usages', 'index_project', 'get_index_status'].sort());
    assert.equal(await fs.stat(index).then(() => true, () => false), false);
    check('Прямой MCP initialize/listTools завершается без создания индекса');

    const first = jsonResult(await direct.call('index_project'));
    assert.equal(first.totalFiles, 2); assert.ok(first.finalCount >= 2); assert.equal(first.embeddingFailures, 0);
    const originalCount = jsonResult(await direct.call('get_index_status')).storeChunkCount;
    assert.equal(originalCount, first.finalCount);
    check('Настоящая проектная модель создала native LanceDB через прямой URL без тестовой подмены CPU-профиля');
    await search(direct, 'Как восстановить доступ, если пользователь забыл пароль?');
    check('Поиск на русском находит собственный исходник без keyword-подмешивания');
    await search(direct, 'Build a link for an account password recovery email');
    check('Поиск на английском находит собственный исходник без keyword-подмешивания');
    const repeat = jsonResult(await direct.call('index_project'));
    assert.equal(repeat.unchangedFiles, 2); assert.equal(repeat.finalCount, originalCount);
    check('Повторная индексация пропускает неизменённые файлы');
    await direct.stop();

    const worker = await startWorker(proxyUrl, 'fault-and-recovery');
    assert.equal(jsonResult(await worker.call('get_index_status')).storeChunkCount, originalCount);

    const beforeFailure = await indexDigest(index);
    mode = 'unavailable';
    const deniedSearch = await worker.call('search_semantic', { query: 'password recovery' });
    assert.equal(deniedSearch.isError, true); assert.ok(!JSON.stringify(deniedSearch).includes(canary));
    assert.equal(await indexDigest(index), beforeFailure);
    await fs.writeFile(path.join(workspace, 'pending.ts'), '/** Adds a task to a pending queue. */\nexport function addPendingTask(queue: string[], task: string): void { queue.push(task); }\n');
    const deniedIndex = await worker.call('index_project');
    assert.equal(deniedIndex.isError, true); assert.ok(!JSON.stringify(deniedIndex).includes(canary));
    assert.equal(jsonResult(await worker.call('get_index_status')).storeChunkCount, originalCount);
    assert.equal(await indexDigest(index), beforeFailure);
    check('HTTP 503 при поиске и индексации сообщает отказ и побайтно сохраняет прежний индекс');

    mode = 'healthy';
    const recovered = jsonResult(await worker.call('index_project'));
    assert.equal(recovered.totalFiles, 3); assert.ok(recovered.finalCount > originalCount); assert.equal(recovered.embeddingFailures, 0);
    await search(worker, 'Как восстановить доступ, если пользователь забыл пароль?');
    assert.equal(jsonResult(await worker.call('index_project')).unchangedFiles, 3);
    check('После восстановления модель достраивает индекс; повтор не обрабатывает готовые файлы');
    await worker.stop();

    const beforeMismatch = await indexDigest(index);
    mode = 'wrong-dimension';
    const mismatch = await startWorker(proxyUrl, 'dimension-mismatch');
    const rejected = await mismatch.call('get_index_status');
    assert.equal(rejected.isError, true); assert.match(JSON.stringify(rejected), /Размерность модели отличается/);
    assert.ok(report.dimensionFaultResponses > 0);
    assert.ok(report.vectorsValidated >= 2);
    await mismatch.stop();
    assert.equal(await indexDigest(index), beforeMismatch);
    check('Новый MCP отклоняет несовместимую размерность без изменения файлов существующего индекса');
    assert.equal(await fs.readFile(path.join(workspace, 'opencode-rag.json'), 'utf8'), config);
    check('Конфигурация собственного проекта не переписана; HOME не переназначен, рабочие проекты не менялись');
    report.status = 'passed';
} catch (error) {
    report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
    for (const worker of workers) {
        try {
            if (worker.stop) await worker.stop();
            else await worker.transport.close();
        } catch (error) {
            report.status = 'failed'; report.cleanupError = error instanceof Error ? error.message : String(error); process.exitCode = 1;
        }
    }
    for (const controller of requests) controller.abort();
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    await fs.rm(temporary, { recursive: true, force: true }); report.temporaryRemoved = true;
    const result = JSON.stringify(report, null, 2) + '\n';
    if (values.output) { await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true }); await fs.writeFile(path.resolve(values.output), result); }
    console.log(result);
}
