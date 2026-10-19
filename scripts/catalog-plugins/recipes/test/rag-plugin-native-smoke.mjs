import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { opencodeVersion } from '../../../opencode-platforms.mjs';

const [runtimeArgument, engineArgument, outputArgument] = process.argv.slice(2);
if (!runtimeArgument || !engineArgument) throw new Error('Укажите каталог готового RAG-плагина и закреплённый OpenCode.');
const runtime = path.resolve(runtimeArgument);
const engine = path.resolve(engineArgument);
const output = outputArgument && path.resolve(outputArgument);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-rag-plugin-native-'));
const home = path.join(temporary, 'home');
const project = path.join(temporary, 'project');
const config = path.join(home, 'config', 'opencode');
const evidence = { status: 'failed', platform: process.platform, architecture: process.arch,
    nodeVersion: process.versions.node, engineVersion: opencodeVersion, checks: [], realProfileChanged: false };
let providerCalls = 0;
let registryCalls = 0;
const providerSecret = 'native-fixture-response-' + randomUUID();
const provider = http.createServer(async (request, response) => {
    try {
        if (request.method === 'GET' && request.url === '/fixture/stats') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ providerCalls }));
            return;
        }
        assert.equal(request.url, '/api/embed');
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.equal(body.model, 'native-plugin-fixture');
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        assert.ok(inputs.length > 0 && inputs.every(input => typeof input === 'string'));
        providerCalls++;
        const status = [401, 503].find(code => inputs.some(input => input.includes('nc-fixture-http-' + code)));
        if (status) {
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: providerSecret }));
            return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: body.model, embeddings: inputs.map(input => input.includes('nc-fixture-dimension')
            ? [1, 0.1, 0.2] : input.includes('nc-fixture-empty') ? [-1, -0.1, -0.2, -0.3] : [1, 0.1, 0.2, 0.3]) }));
    } catch (error) {
        response.writeHead(400);
        response.end(error.message);
    }
});
const registry = http.createServer((_request, response) => { registryCalls++; response.writeHead(503); response.end(); });

/** Выполняется внутри настоящего OpenCode; запросы плагина ограничены локальным fixture. */
async function exercisePlugin(input, options) {
    const { default: assert } = await import('node:assert/strict');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const externalRequests = [];
    const originalFetch = globalThis.fetch;
    let hooks;
    globalThis.fetch = (request, ...args) => {
        const url = new URL(typeof request === 'string' || request instanceof URL ? request : request.url);
        if (url.origin !== options.providerOrigin) {
            externalRequests.push(url.origin + url.pathname);
            throw new Error('Сетевой запрос вне локального fixture запрещён.');
        }
        return originalFetch(request, ...args);
    };
    const waitFor = async (callback, description) => {
        const until = Date.now() + 30_000;
        while (Date.now() < until) {
            const value = await callback();
            if (value) return value;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Не дождались: ${description}`);
    };
    const statusPath = path.join(input.directory, '.opencode', 'rag-store', 'watcher-status.json');
    const readStatus = async () => JSON.parse(await fs.readFile(statusPath, 'utf8').catch(() => '{}'));
    try {
        const { managedRagConfiguration } = await import(new URL('./rag-plugin-config.mjs', options.pluginUrl).href);
        const { DEFAULT_CONFIG } = await import(new URL('./upstream/dist/core/config.js', options.pluginUrl).href);
        const { applyRuntimeOverrides } = await import(new URL('./upstream/dist/core/runtime-overrides.js', options.pluginUrl).href);
        const overridden = applyRuntimeOverrides(managedRagConfiguration(DEFAULT_CONFIG, true), { autoUpdate: { enabled: true, autoInstall: true } });
        assert.equal(overridden.autoUpdate.enabled, false);
        assert.equal(overridden.autoUpdate.autoInstall, false);
        const { default: plugin } = await import(options.pluginUrl);
        hooks = await plugin(input);
        assert.deepEqual(Object.keys(hooks).sort(), ['event', 'tool', 'tool.execute.after', 'experimental.chat.system.transform', 'chat.message'].sort());
        assert.deepEqual(Object.keys(hooks.tool).sort(), ['search_semantic', 'get_file_skeleton', 'find_usages', 'describe_image',
            'recall_quirks', 'add_quirk', 'update_quirk', 'delete_quirk', 'read'].sort());
        const context = { directory: input.directory, worktree: input.directory, agent: 'build', sessionID: 'native-fixture',
            messageID: 'native-fixture-message', abort: new AbortController().signal, metadata() {},
            ask() { throw new Error('Fixture не запрашивает дополнительные права.'); } };
        const skeleton = await hooks.tool.get_file_skeleton.execute({ filePath: 'sample.ts' }, context);
        assert.match(skeleton.output, /calculateInvoiceTotal/);
        const system = { system: [] };
        await hooks['experimental.chat.system.transform']({}, system);
        assert.ok(system.system.some(line => line.includes('search_semantic')));
        await hooks.event({ event: { type: 'session.idle', properties: {} } });
        await hooks['tool.execute.after']({ tool: 'read', sessionID: context.sessionID }, { output: 'fixture' });
        const first = await waitFor(async () => {
            const status = await readStatus();
            return !status.running && status.lastSuccessAt && status;
        }, 'первое автоматическое индексирование');
        const search = await hooks.tool.search_semantic.execute({ query: 'calculateInvoiceTotal invoice total' }, context);
        assert.match(search.output, /calculateInvoiceTotal/);
        assert.ok(search.metadata.chunks > 0);
        await fs.writeFile(path.join(input.directory, 'sample.ts'), 'export function calculateRevisedInvoice(amount: number): number { return amount * 3; }\n');
        await waitFor(async () => {
            const status = await readStatus();
            return !status.running && status.lastSuccessAt > first.lastSuccessAt;
        }, 'автоматическое обновление после изменения файла');
        const updated = await hooks.tool.search_semantic.execute({ query: 'calculateRevisedInvoice revised invoice' }, context);
        assert.match(updated.output, /calculateRevisedInvoice/);
        assert.doesNotMatch(updated.output, /calculateInvoiceTotal/);
        const calls = async () => (await (await fetch(options.providerOrigin + '/fixture/stats')).json()).providerCalls;
        const failures = [];
        for (const query of ['nc-fixture-http-401', 'nc-fixture-http-503', 'nc-fixture-dimension']) {
            const before = await calls();
            const result = await hooks.tool.search_semantic.execute({ query }, context);
            assert.equal(await calls() - before, 1, 'Отказ не повторяет запрос к модели');
            assert.equal(result.metadata.indexed, false);
            assert.match(result.output, /Поиск не выполнен/);
            if (query.includes('http-')) assert.match(result.output, new RegExp('HTTP ' + query.slice(-3)));
            assert.ok(!JSON.stringify(result).includes(options.providerSecret));
            failures.push({ query, output: result.output });
        }
        const beforeEmpty = await calls();
        const empty = await hooks.tool.search_semantic.execute({ query: 'nc-fixture-empty' }, context);
        assert.equal(await calls() - beforeEmpty, 1);
        assert.equal(empty.metadata.indexed, true);
        assert.equal(empty.metadata.chunks, 0);
        assert.doesNotMatch(empty.output, /Поиск не выполнен|Search failed/);
        const beforeUsages = await calls();
        const usages = await hooks.tool.find_usages.execute({ symbolName: 'nc-fixture-http-401' }, context);
        assert.equal(await calls() - beforeUsages, 1);
        assert.match(usages.output, /Search failed.*HTTP 401/);
        assert.ok(!JSON.stringify(usages).includes(options.providerSecret));
        let scannedFiles = 0;
        const assertNoSecrets = async directory => {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                const file = path.join(directory, entry.name);
                if (entry.isDirectory()) await assertNoSecrets(file);
                else if (entry.isFile()) {
                    scannedFiles++;
                    assert.ok(!(await fs.readFile(file)).includes(Buffer.from(options.providerSecret)), 'Ответ провайдера попал в локальный файл');
                }
            }
        };
        await assertNoSecrets(input.directory);
        await assertNoSecrets(options.home);
        const preservedConfig = await fs.readFile(path.join(input.directory, 'opencode-rag.json'), 'utf8');
        assert.equal(preservedConfig, options.originalConfig);
        assert.equal(await fs.stat(path.join(input.directory, '.opencode', 'opencode-rag.json')).then(() => true).catch(() => false), false);
        assert.deepEqual(externalRequests, []);
        const emptyProject = options.emptyProject;
        await fs.mkdir(emptyProject);
        const net = await import('node:net');
        const originalConnect = net.Socket.prototype.connect;
        const { LanceDbStore } = await import(new URL('./upstream/dist/vectorstore/lancedb.js', options.pluginUrl).href);
        const originalDimension = LanceDbStore.prototype.getVectorDimension;
        let initializing = true; let startupModelCalls = 0; let defaultDimension;
        LanceDbStore.prototype.getVectorDimension = function (...args) {
            if (this.dbPath === path.resolve(emptyProject, DEFAULT_CONFIG.vectorStore.path)) defaultDimension = this.vectorDimension;
            return originalDimension.apply(this, args);
        };
        net.Socket.prototype.connect = function (...args) {
            const first = Array.isArray(args[0]) ? args[0][0] : args[0];
            const port = Number(first && typeof first === 'object' ? first.port : first);
            if (port === 11435) {
                if (initializing) startupModelCalls++;
                throw new Error('Локальная модель не вызывается из пустого native fixture.');
            }
            return originalConnect.apply(this, args);
        };
        try {
            const emptyHooks = await plugin({ ...input, directory: emptyProject, worktree: emptyProject });
            initializing = false;
            assert.equal(startupModelCalls, 0, 'Известная локальная модель не требует startup dimension probe');
            assert.equal(defaultDimension, 2560, 'Настоящий LanceDB handle создан с размерностью закреплённой модели');
            const emptyContext = { ...context, directory: emptyProject, worktree: emptyProject };
            const beforeIndex = await emptyHooks.tool.search_semantic.execute({ query: 'empty project' }, emptyContext);
            assert.equal(beforeIndex.metadata.chunks, 0);
            assert.equal(beforeIndex.metadata.indexed, false);
            assert.match(beforeIndex.output, /No indexed chunks are available yet/);
            assert.equal(await fs.stat(path.join(emptyProject, 'opencode-rag.json')).then(() => true).catch(() => false), false);
        } finally {
            process.emit('beforeExit', 0);
            await waitFor(async () => !(await fs.stat(path.resolve(emptyProject, DEFAULT_CONFIG.vectorStore.path, 'watcher.lock')).then(() => true).catch(() => false)), 'остановка пустого fixture');
            net.Socket.prototype.connect = originalConnect;
            LanceDbStore.prototype.getVectorDimension = originalDimension;
        }
        await fs.writeFile(options.marker, JSON.stringify({ hooks: Object.keys(hooks), tools: Object.keys(hooks.tool),
            skeleton: true, systemTransform: true, automaticIndex: true, automaticReindex: true,
            configPreserved: true, runtimeOverridesCannotEnableUpdater: true, failures,
            validEmptySearch: true, failedUsages: true, singleEmbeddingPerQuery: true, startupModelCalls,
            defaultDimension, emptyProjectBeforeIndex: true, secretScan: { scannedFiles, leakedFiles: [] }, externalRequests }));
    } finally {
        // Upstream освобождает watchers, LanceDB и HTTP pool через beforeExit.
        process.emit('beforeExit', 0);
        if (hooks) await waitFor(async () => !(await fs.stat(path.join(input.directory, '.opencode', 'rag-store', 'watcher.lock')).then(() => true).catch(() => false)), 'остановка watcher');
        globalThis.fetch = originalFetch;
    }
    return hooks;
}

/** Дочерний процесс получает только изолированный профиль и известные настройки OpenCode. */
function run(args, env, timeout = 60_000) {
    return new Promise((resolve, reject) => {
        const child = spawn(engine, args, { cwd: project, env, shell: false });
        let stdout = ''; let stderr = ''; let timedOut = false; let forceKill;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
            forceKill.unref();
        }, timeout);
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', exit => {
            clearTimeout(timer);
            clearTimeout(forceKill);
            if (exit === 0 && !timedOut) resolve({ stdout, stderr });
            else reject(new Error(`OpenCode завершился с ${exit}${timedOut ? ' (timeout)' : ''}: ${stderr.slice(-6000)}`));
        });
    });
}

try {
    await Promise.all([new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)), new Promise(resolve => registry.listen(0, '127.0.0.1', resolve))]);
    for (const directory of [project, config, path.join(config, 'node_modules'), path.join(project, 'node_modules'), path.join(temporary, 'node_modules')]) await fs.mkdir(directory, { recursive: true });
    const dependency = { '@opencode-ai/plugin': opencodeVersion };
    await fs.writeFile(path.join(config, 'package.json'), JSON.stringify({ private: true, dependencies: dependency }));
    await fs.writeFile(path.join(config, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: dependency } } }));
    await fs.writeFile(path.join(config, '.gitignore'), 'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n');
    const bunfig = 'telemetry = false\nenv = false\n[install]\nauto = "disable"\n';
    await fs.writeFile(path.join(project, 'bunfig.toml'), bunfig);
    await fs.writeFile(path.join(home, '.bunfig.toml'), bunfig);
    const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
    const originalConfig = JSON.stringify({ embedding: { provider: 'ollama', baseUrl: providerOrigin + '/api', model: 'native-plugin-fixture' },
        indexing: { includeExtensions: ['.ts'], minFileSizeBytes: 0, embedBatchSize: 1, embedConcurrency: 1 },
        retrieval: { minScore: 0.8, hybridSearch: { enabled: false } },
        vectorStore: { path: '.opencode/rag-store' }, description: { enabled: false }, imageDescription: { enabled: false },
        reranking: { enabled: false }, memory: { enabled: false }, decision: { enabled: false },
        openCode: { enabled: true, readOverride: true, autoIndex: { enabled: true, debounceMs: 100, intervalMs: 300_000 } },
        autoUpdate: { enabled: true, autoInstall: true } }, null, 2) + '\n';
    await fs.writeFile(path.join(project, 'opencode-rag.json'), originalConfig);
    await fs.writeFile(path.join(project, 'sample.ts'), 'export function calculateInvoiceTotal(amount: number): number { return amount * 2; }\n');
    const marker = path.join(temporary, 'proof.json');
    const wrapper = path.join(temporary, 'wrapper.mjs');
    const options = { marker, originalConfig, providerOrigin, providerSecret, home, emptyProject: path.join(temporary, 'empty-project'),
        pluginUrl: pathToFileURL(path.join(runtime, 'rag-plugin.mjs')).href };
    await fs.writeFile(wrapper, `import fs from 'node:fs/promises';export default async function(input) { try { return await (${exercisePlugin.toString()})(input, ${JSON.stringify(options)}); }
catch(error) { await fs.writeFile(${JSON.stringify(marker)}, JSON.stringify({error:error.stack})); throw error; } }\n`);
    await fs.writeFile(path.join(config, 'opencode.json'), JSON.stringify({ plugin: [pathToFileURL(wrapper).href], mcp: {}, enabled_providers: [], provider: {},
        lsp: false, formatter: false, autoupdate: false, snapshot: false, share: 'disabled', permission: { '*': 'deny' } }));
    const registryUrl = `http://127.0.0.1:${registry.address().port}`;
    const env = { HOME: home, USERPROFILE: home, PATH: '', TERM: 'dumb', NO_COLOR: '1',
        XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'),
        OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(temporary, 'managed'), OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_IGNORE_SCRIPTS: 'true', npm_config_registry: registryUrl, NPM_CONFIG_REGISTRY: registryUrl };
    await fs.chmod(path.join(config, 'node_modules'), 0o500);
    await fs.chmod(config, 0o500);
    assert.equal((await run(['--version'], env, 15_000)).stdout.trim(), opencodeVersion);
    const command = await run(['debug', 'config'], env, 90_000);
    assert.ok(!command.stdout.includes(providerSecret) && !command.stderr.includes(providerSecret));
    const proof = JSON.parse(await fs.readFile(marker, 'utf8'));
    assert.ok(!proof.error, proof.error);
    assert.ok(proof.automaticIndex && proof.automaticReindex && proof.configPreserved);
    assert.ok(providerCalls >= 4);
    assert.equal(registryCalls, 0);
    evidence.checks = ['Настоящий OpenCode загрузил 5 hooks и 9 tools из готового плагина',
        'WASM skeleton и system transform выполнены внутри OpenCode', 'Автоиндексирование записало настоящий LanceDB и семантический поиск вернул исходный файл',
        'Изменение файла автоматически обновило индекс и результат поиска', 'Явный autoUpdate в проектном конфиге не запускает запросы или установку',
        'HTTP 401/503 и неверная размерность возвращают отказ без повторного embedding; настоящее отсутствие совпадений успешно',
        'find_usages сохраняет отказ провайдера; ответ провайдера отсутствует в инструментах, stdout, stderr, файлах проекта и HOME',
        'Пустой проект без конфига инициализирует LanceDB с размерностью 2560 без startup-запроса к модели; поиск до индексации сообщает о пустом индексе',
        'Исходный конфиг сохранён побайтно; дополнительный конфиг не создан', 'Watchers и LanceDB завершены; registry не использовался'];
    evidence.proof = proof;
    evidence.status = 'passed';
} catch (error) {
    evidence.error = error.stack;
    process.exitCode = 1;
} finally {
    await Promise.all([new Promise(resolve => provider.close(resolve)), new Promise(resolve => registry.close(resolve))]);
    await fs.chmod(config, 0o700).catch(() => {});
    await fs.chmod(path.join(config, 'node_modules'), 0o700).catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true });
    evidence.temporaryProfileRemoved = true;
    evidence.providerCalls = providerCalls;
    evidence.registryCalls = registryCalls;
    if (output) { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n'); }
    console.log(JSON.stringify(evidence, null, 2));
}
