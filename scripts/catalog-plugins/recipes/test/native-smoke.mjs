import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const [ragDirectory, snipDirectory, output] = process.argv.slice(2).map(value => path.resolve(value));
if (!ragDirectory || !snipDirectory) throw new Error('Укажите каталоги подготовленных RAG и snip.');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-catalog-plugins-'));
const workspace = path.join(temporary, 'workspace');
const home = path.join(temporary, 'home');
const evidence = { platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node, checks: [], realProfileChanged: false };
const check = name => evidence.checks.push(name);
await fs.mkdir(workspace);
await fs.mkdir(home);
await fs.writeFile(path.join(workspace, 'sample.ts'), 'export function calculateInvoiceTotal(amount: number): number { return amount * 2; }\n');
await fs.writeFile(path.join(temporary, 'outside.ts'), 'export const outsideSecret = 42;\n');
await fs.symlink(path.join(temporary, 'outside.ts'), path.join(workspace, 'escape.ts'));
await fs.mkdir(path.join(workspace, 'node_modules'));
await fs.writeFile(path.join(workspace, 'node_modules', 'excluded.ts'), 'export const excluded = true;\n');
let providerCalls = 0;
let providerUnavailable = false;
const providerSecret = 'nc-native-fixture-' + randomUUID();
const provider = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    providerCalls++;
    if (providerUnavailable) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: `Fixture credential rejected: ${providerSecret}` }));
        return;
    }
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model: 'fixture', embeddings: inputs.map(() => [1, 0.1, 0.2, 0.3]) }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
    NEUROCENTER_RAG_EMBEDDING_URL: `http://127.0.0.1:${provider.address().port}/api`,
    NEUROCENTER_RAG_EMBEDDING_MODEL: 'fixture', NEUROCENTER_RAG_EMBEDDING_PROVIDER: 'ollama',
    NEUROCENTER_RAG_EMBEDDING_KEY: providerSecret, LOG_LEVEL: 'info' };
async function assertNoSecretFiles(directory, files = []) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await assertNoSecretFiles(filename, files);
        else if (entry.isFile()) {
            const relative = path.relative(temporary, filename);
            files.push(relative);
            assert.ok(!(await fs.readFile(filename)).includes(Buffer.from(providerSecret)), `Ключ попал в файл ${relative}`);
        }
    }
    return files;
}
let client;
let transport;
try {
    const { Client } = await import(pathToFileURL(path.join(ragDirectory, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
    const { StdioClientTransport } = await import(pathToFileURL(path.join(ragDirectory, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
    client = new Client({ name: 'neurocenter-native-fixture', version: '1' });
    transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ragDirectory, 'rag-mcp.mjs')], cwd: workspace, env, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += chunk; });
    await client.connect(transport);
    check('MCP initialize завершён на bundled Node');
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['search_semantic', 'get_file_skeleton', 'find_usages', 'index_project', 'get_index_status'].sort());
    assert.equal(providerCalls, 0);
    check('listTools не обращается к провайдеру и не индексирует');
    const skeleton = await client.callTool({ name: 'get_file_skeleton', arguments: { filePath: 'sample.ts' } });
    assert.ok(!skeleton.isError, JSON.stringify(skeleton));
    assert.match(JSON.stringify(skeleton), /calculateInvoiceTotal/);
    assert.equal(providerCalls, 0);
    check('WASM извлекает реальную структуру TypeScript без модели');
    for (const filePath of ['../outside.ts', 'escape.ts']) {
        const result = await client.callTool({ name: 'get_file_skeleton', arguments: { filePath } });
        assert.equal(result.isError, true);
        assert.doesNotMatch(JSON.stringify(result), /outsideSecret/);
    }
    check('Чтение вне проекта и через ссылку отклоняется');
    const invalidIndex = await client.callTool({ name: 'index_project', arguments: { cwd: temporary } });
    assert.equal(invalidIndex.isError, true);
    assert.equal(providerCalls, 0);
    check('Индексированию нельзя передать другую папку');
    const { DEFAULT_CONFIG } = await import(pathToFileURL(path.join(ragDirectory, 'upstream/dist/core/config.js')));
    assert.equal(DEFAULT_CONFIG.logging.level, 'info');
    providerUnavailable = true;
    const deniedProbe = await client.callTool({ name: 'get_index_status', arguments: {} });
    assert.equal(deniedProbe.isError, true);
    await assertNoSecretFiles(workspace);
    check('Отказ dimension probe при logging.info не записывает ответ с ключом в проектные файлы');
    providerUnavailable = false;
    const index = await client.callTool({ name: 'index_project', arguments: {} }, undefined, { timeout: 120_000 });
    assert.ok(!index.isError, JSON.stringify(index) + stderr);
    const stats = JSON.parse(index.content[0].text);
    assert.equal(stats.totalFiles, 1);
    assert.ok(stats.finalCount > 0, JSON.stringify(stats));
    assert.equal(stats.embeddingFailures, 0);
    assert.ok(providerCalls > 0);
    check('Настоящий native LanceDB сохраняет индекс; node_modules и ссылки исключены');
    const search = await client.callTool({ name: 'search_semantic', arguments: { query: 'invoice total' } });
    assert.ok(!search.isError, JSON.stringify(search));
    assert.match(JSON.stringify(search), /calculateInvoiceTotal/);
    check('Семантический поиск возвращает проиндексированный исходный файл');
    const again = await client.callTool({ name: 'index_project', arguments: {} }, undefined, { timeout: 120_000 });
    assert.ok(!again.isError, JSON.stringify(again));
    assert.equal(JSON.parse(again.content[0].text).unchangedFiles, 1);
    check('Повторное индексирование сохраняет неизменённые файлы');
    providerUnavailable = true;
    const deniedSearch = await client.callTool({ name: 'search_semantic', arguments: { query: 'invoice total' } });
    assert.equal(deniedSearch.isError, true);
    assert.ok(!JSON.stringify(deniedSearch).includes(providerSecret));
    const scanned = [...await assertNoSecretFiles(workspace), ...await assertNoSecretFiles(home)];
    assert.ok(!stderr.includes(providerSecret));
    evidence.secretScan = { filesScanned: scanned.length, logFiles: scanned.filter(file => /\.log(?:\.|$)/i.test(file)), leakedFiles: [], loggingLevel: 'info' };
    check('Отказ Ollama не раскрывает ключ в MCP, stderr и любых файлах проекта и HOME');
    providerUnavailable = false;
    assert.equal(await fs.stat(path.join(workspace, 'opencode-rag.json')).then(() => true).catch(() => false), false);
    check('Конфигурация проекта не переписывается');
    await client.close();
    client = undefined;
    const snipResult = await new Promise((resolve, reject) => {
        const code = `const {default:plugin}=await import(${JSON.stringify(pathToFileURL(path.join(snipDirectory, 'plugin.mjs')).href)});const hooks=await plugin();const output={args:{command:'git status'}};await hooks['tool.execute.before']({tool:'bash'},output);const complex={args:{command:'echo $(pwd)'}};await hooks['tool.execute.before']({tool:'bash'},complex);const other={args:{command:'git status'}};await hooks['tool.execute.before']({tool:'read'},other);console.log(JSON.stringify({command:output.args.command,complex:complex.args.command,other:other.args.command}));`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: workspace, env, shell: false });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject); child.once('close', exit => exit === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    });
    assert.match(snipResult.command, /snip["']? run -- git status$/);
    assert.ok(snipResult.command.includes(path.join(snipDirectory, 'bin', 'snip')));
    assert.equal(snipResult.complex, 'echo $(pwd)');
    assert.equal(snipResult.other, 'git status');
    check('Native snip hook использует абсолютный CLI, сложные команды проходят без изменений');
    evidence.providerCalls = providerCalls;
    evidence.status = 'passed';
} catch (error) {
    evidence.status = 'failed'; evidence.error = error.stack;
    process.exitCode = 1;
} finally {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    await new Promise(resolve => provider.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
    evidence.temporaryProfileRemoved = true;
    if (output) { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n'); }
    console.log(JSON.stringify(evidence, null, 2));
}
