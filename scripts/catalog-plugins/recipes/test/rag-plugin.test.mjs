import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { managedRagConfiguration } from '../adapters/rag-plugin-config.mjs';
import { nativeSearchFailure, protectedNativeStore } from '../adapters/rag-plugin-errors.mjs';
import { applyManagedPluginCompatibility, prepareOpenCodeRagPlugin, RAG_PLUGIN_DEPENDENCIES } from '../opencode-rag-plugin.mjs';

function configuration() {
    return { embedding: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/api', model: 'qwen3-embedding:0.6b' },
        indexing: { embedBatchSize: 100, embedConcurrency: 3, includeExtensions: ['.ts'] },
        openCode: { enabled: true, autoIndex: { enabled: false, debounceMs: 2000 } },
        description: { enabled: true }, imageDescription: { enabled: true }, decision: { enabled: false }, reranking: { enabled: true },
        autoUpdate: { enabled: true, autoInstall: true, cooldownMs: 1000 } };
}

test('Новый проект использует локальную CPU-модель и автоиндексацию без вызовов дополнительных моделей', () => {
    const original = configuration();
    const managed = managedRagConfiguration(original, false);
    assert.deepEqual(managed.embedding, { provider: 'ollama', baseUrl: 'http://127.0.0.1:11435/api', model: 'qwen3-embedding:4b', vectorDimension: 2560, timeoutMs: 120000 });
    assert.deepEqual(managed.indexing, { embedBatchSize: 1, embedConcurrency: 1, includeExtensions: ['.ts'] });
    assert.deepEqual(managed.openCode.autoIndex, { enabled: true, debounceMs: 2000 });
    for (const name of ['description', 'imageDescription', 'decision', 'reranking']) assert.equal(managed[name].enabled, false);
    assert.deepEqual(managed.autoUpdate, { enabled: false, autoInstall: false, cooldownMs: 1000 });
    assert.deepEqual(original, configuration());
});

test('Существующие модель, ключ, функции и отключённая автоиндексация сохраняются в памяти', () => {
    const configured = configuration();
    configured.embedding = { provider: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'custom', apiKey: 'fixture-local-secret', timeoutMs: 75000 };
    const managed = managedRagConfiguration(configured, true);
    assert.deepEqual(managed, { ...configured, autoUpdate: { ...configured.autoUpdate, enabled: false, autoInstall: false } });
    assert.equal(configured.autoUpdate.autoInstall, true);
    managed.embedding.apiKey = 'changed';
    assert.equal(configured.embedding.apiKey, 'fixture-local-secret');
});

test('Локальный CPU-профиль применяется и к уже настроенной модели проекта', () => {
    const configured = configuration();
    configured.embedding = { provider: 'ollama', baseUrl: 'http://localhost:11435/api', model: 'qwen3-embedding:4b', timeoutMs: 1000 };
    const managed = managedRagConfiguration(configured, true);
    assert.equal(managed.embedding.timeoutMs, 120000);
    assert.equal(managed.indexing.embedConcurrency, 1);
    assert.equal(managed.openCode.autoIndex.enabled, false);
});

test('Адаптер меняет ровно одну известную инициализацию upstream, неизвестный исходник остаётся нетронут', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-plugin-patch-'));
    const file = path.join(root, 'upstream/dist/plugin.js');
    const init = 'const cfg = await getConfig(input.directory);';
    try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        for (const source of ['export default async function() {}', init + '\n' + init, init]) {
            await fs.writeFile(file, source);
            await assert.rejects(applyManagedPluginCompatibility(root), /инициализации/);
            assert.equal(await fs.readFile(file, 'utf8'), source);
        }
        const source = `before\n${init}\npersistProbedDimension(configPath, vectorDimension);
const embedder = createEmbedder(effectiveCfg);
const store = createVectorStore(effectiveCfg, storePath, vectorDimension);
    retrieve,
};
output: "Search failed. The index may need to be rebuilt.",
after`;
        for (const changed of ['const embedder = createEmbedder(effectiveCfg);', 'const store = createVectorStore(effectiveCfg, storePath, vectorDimension);', '    retrieve,\n};']) {
            await fs.writeFile(file, source.replace(changed, 'changed'));
            await assert.rejects(applyManagedPluginCompatibility(root), /инициализации/);
            assert.equal(await fs.readFile(file, 'utf8'), source.replace(changed, 'changed'));
        }
        await fs.writeFile(file, source);
        assert.deepEqual(await applyManagedPluginCompatibility(root), { id: 'neurocenter-opencode1-plugin-configuration', version: 2, file: 'upstream/dist/plugin.js' });
        const patched = await fs.readFile(file, 'utf8');
        assert.match(patched, /^import \{ managedRagConfiguration \} from "\.\.\/\.\.\/rag-plugin-config.mjs";/);
        assert.match(patched, /managedRagConfiguration\(await getConfig\(input.directory\), Boolean\(findConfigFile\(input.directory\)\)\)/);
        assert.ok(!patched.includes('persistProbedDimension(configPath, vectorDimension);'));
        assert.match(patched, /protectedEmbedder\(createEmbedder/);
        assert.match(patched, /protectedNativeStore\(createVectorStore/);
        assert.match(patched, /retrieve: strictRetriever\(retrieve\)/);
        assert.match(patched, /output: nativeSearchFailure\(err\)/);
        assert.ok(patched.endsWith('after'));
        await assert.rejects(applyManagedPluginCompatibility(root), /инициализации/);
        assert.equal(await fs.readFile(file, 'utf8'), patched);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Размерность проверяется до скрывающего отказ поиска; методы сохраняют private this', async () => {
    let searches = 0;
    class Store {
        #dimension = 4;
        async getVectorDimension() { return this.#dimension; }
        async searchWithFilter() { searches++; return []; }
    }
    const store = protectedNativeStore(new Store());
    await assert.rejects(store.searchWithFilter([1, 0, 0]), /Размерность/);
    assert.equal(searches, 0);
    assert.deepEqual(await store.searchWithFilter([1, 0, 0, 0]), []);
    assert.equal(searches, 1);
    assert.equal(await store.getVectorDimension(), 4);
});

test('Ошибка поиска сохраняет HTTP-статус или причину индекса, исключая ответ провайдера', () => {
    const secret = 'fixture-sensitive-response';
    for (const status of [401, 503]) {
        const message = nativeSearchFailure(new Error(`Ошибка провайдера эмбеддингов (HTTP ${status}): ${secret}`));
        assert.match(message, new RegExp(`HTTP ${status}`));
        assert.ok(!message.includes(secret));
    }
    assert.match(nativeSearchFailure(new Error('Ошибка локального индекса. ' + secret)), /индекса/);
    assert.ok(!nativeSearchFailure(new Error(secret)).includes(secret));
});

test('Lock плагина закрепляет совместимый SDK и все зависимости через официальный registry с integrity', async () => {
    const lock = JSON.parse(await fs.readFile(new URL('../../locks/opencode-rag-plugin.json', import.meta.url), 'utf8'));
    assert.deepEqual(lock.packages[''].dependencies, RAG_PLUGIN_DEPENDENCIES);
    assert.equal(lock.packages['node_modules/@opencode-ai/plugin'].version, '1.14.48');
    assert.ok(!lock.packages['node_modules/@opencode/plugin']);
    for (const [name, pkg] of Object.entries(lock.packages)) {
        if (!name) continue;
        assert.equal(new URL(pkg.resolved).origin, 'https://registry.npmjs.org');
        assert.match(pkg.integrity, /^sha(?:256|512)-/);
    }
});

test('Неподдерживаемая платформа плагина отклоняется до создания папки и сетевых запросов', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-plugin-platform-'));
    const directory = path.join(root, 'absent');
    try {
        await assert.rejects(prepareOpenCodeRagPlugin({ target: 'darwin-x64', directory }), /Intel Mac/);
        await assert.rejects(prepareOpenCodeRagPlugin({ target: 'linux-mips', directory }), /Неизвестная платформа/);
        await assert.rejects(fs.access(directory), { code: 'ENOENT' });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
