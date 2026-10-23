import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runManagedRagCli } from '../adapters/opencode-rag.mjs';
import { withManagedUiMutation, closeManagedUiMutations, managedUiReindex, managedUiRequests } from '../adapters/rag-ui-guards.mjs';
import { acquireManagedIndexLock, releaseManagedIndexLock, preserveManagedSessionLock } from '../adapters/rag-index-lock.mjs';
import { RAG_LOCAL_UI } from '../rag-web-ui.mjs';
import { rememberUiConfig, persistUiConfigPatch } from '../adapters/rag-ui-config.mjs';
import * as uiGuards from '../adapters/rag-ui-guards.mjs';

async function fixture(action) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-ui-guards-'));
    try { return await action(directory); }
    finally { await closeManagedUiMutations(); await fs.rm(directory, { recursive: true, force: true }); }
}

test('CLI принимает только фиксированные управляемые команды и не исполняет лишние аргументы', async () => {
    for (const args of [[], ['setup'], ['update'], ['mcp', '--config', '/outside'], ['ui', '--port', '22'],
        ['ui', '--port', 'NaN'], ['ui', '--port', '65536'], ['ui', '--port', '3210;exit'], ['ui', '--open'], ['ui', '--port', '0', '--port', '1']]) {
        await assert.rejects(runManagedRagCli(args));
    }
    assert.deepEqual(RAG_LOCAL_UI, { schemaVersion: 1, application: 'opencode-rag', entrypoint: 'opencode-rag.mjs', args: ['ui', '--port', '0', '--no-open'] });
});

test('Изменение UI блокируется действующей native-сессией и не удаляет её lock', () => fixture(async directory => {
    const file = path.join(directory, 'neurocenter-session.lock');
    const original = JSON.stringify({ pid: process.pid, owner: 'foreign-native-session' }); await fs.writeFile(file, original, { flag: 'wx' });
    let called = false;
    await assert.rejects(withManagedUiMutation(directory, async () => { called = true; }), error => error.statusCode === 409);
    assert.equal(called, false); assert.equal(await fs.readFile(file, 'utf8'), original);
}));

test('Собственные изменения сериализуются, закрытие ждёт abort и освобождения lock', () => fixture(async directory => {
    let signal, started; const entered = new Promise(resolve => { started = resolve; });
    const work = withManagedUiMutation(directory, current => new Promise(resolve => { signal = current; started(); current.addEventListener('abort', resolve, { once: true }); }));
    await entered;
    await assert.rejects(withManagedUiMutation(directory, async () => {}), error => error.statusCode === 409);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'neurocenter-session.lock'), 'utf8')).pid, process.pid);
    await closeManagedUiMutations(); await work;
    assert.equal(signal.aborted, true);
    await assert.rejects(fs.access(path.join(directory, 'neurocenter-session.lock')), { code: 'ENOENT' });
}));

test('Presence Web UI сохраняется при атомарном перестроении индекса', () => fixture(async directory => {
    const temporary = path.join(directory, 'next'); await fs.mkdir(temporary);
    const presence = path.join(directory, 'neurocenter-ui-session.lock');
    assert.equal(await acquireManagedIndexLock(presence), true);
    await preserveManagedSessionLock(directory, temporary);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary, 'neurocenter-ui-session.lock'), 'utf8')), JSON.parse(await fs.readFile(presence, 'utf8')));
    await releaseManagedIndexLock(presence);
    await assert.rejects(fs.access(presence), { code: 'ENOENT' });
}));

test('Обзор native UI доступен во время сессии OpenCode без блокировки записи', () => fixture(async directory => {
    await fs.writeFile(path.join(directory, 'neurocenter-session.lock'), JSON.stringify({ pid: process.pid, owner: 'native' }));
    let calls = 0;
    const handler = managedUiRequests(async () => { calls++; return true; }, { root: directory, storePath: directory });
    assert.equal(await handler({ url: '/api/stats', method: 'GET' }, {}), true); assert.equal(calls, 1);
}));

test('Reindex возвращает 409 до обращения к модели, если индекс используется', () => fixture(async directory => {
    await fs.writeFile(path.join(directory, 'neurocenter-session.lock'), JSON.stringify({ pid: process.pid, owner: 'native' }));
    let calls = 0;
    const result = await managedUiReindex({ storePath: directory, getEmbedder: async () => { calls++; }, onFinished() {} });
    assert.equal(result.status, 409); assert.equal(calls, 0);
}));

test('Фоновая индексация удерживает writer после ответа started и закрывается с UI', () => fixture(async directory => {
    let abortSignal;
    const result = await managedUiReindex({ cwd: directory, storePath: directory, cfg: { embedding: { vectorDimension: 4 } }, store: {}, getEmbedder: async () => ({}),
        runIndexPass: options => new Promise(resolve => { abortSignal = options.abortSignal; options.abortSignal.addEventListener('abort', resolve, { once: true }); }), onFinished() {} });
    assert.equal(result.status, 200); assert.equal(result.body.started, true);
    await assert.rejects(withManagedUiMutation(directory, async () => {}), error => error.statusCode === 409);
    await closeManagedUiMutations(); assert.equal(abortSignal.aborted, true);
    await assert.rejects(fs.access(path.join(directory, 'neurocenter-session.lock')), { code: 'ENOENT' });
}));

test('Фоновый частичный отказ становится видимым terminal failed без утечки ключа и изменения конфига', () => fixture(async directory => {
    let finished; const done = new Promise(resolve => { finished = resolve; });
    const cfg = { embedding: { vectorDimension: 2560, apiKey: 'fixture-secret' } }, original = JSON.stringify(cfg);
    const result = await managedUiReindex({ cwd: directory, storePath: directory, cfg, store: {}, getEmbedder: async () => ({}),
        runIndexPass: async () => ({ embeddingFailures: 1, embeddingUnavailable: false }), onFinished: finished });
    assert.equal(result.body.started, true); await done;
    assert.equal(typeof uiGuards.managedUiIndexingStatus, 'function');
    const status = uiGuards.managedUiIndexingStatus({ status: 200, body: { manifest: { lastIndexedAt: null }, staleFileCount: 0 } }, directory);
    assert.equal(status.body.reindex.state, 'failed'); assert.equal(status.body.reindex.id, result.body.runId);
    assert.ok(status.body.reindex.error); assert.equal(JSON.stringify(status).includes('fixture-secret'), false);
    assert.equal(status.body.freshness, 'never'); assert.equal(JSON.stringify(cfg), original);
}));

test('Статус показывает фактические файлы и завершение, повторный конфликт не затирает текущий проход', () => fixture(async directory => {
    let release, finished; const done = new Promise(resolve => { finished = resolve; });
    const result = await managedUiReindex({ cwd: directory, storePath: directory, cfg: { embedding: { vectorDimension: 2560 } }, store: {}, getEmbedder: async () => ({}),
        runIndexPass: async ({ progress }) => { progress.setFileCount(2); progress.startFile('src/a.ts'); progress.finishFile('src/a.ts'); await new Promise(resolve => { release = resolve; }); return { embeddingFailures: 0 }; }, onFinished: finished });
    assert.equal(typeof uiGuards.managedUiIndexingStatus, 'function');
    const read = () => uiGuards.managedUiIndexingStatus({ status: 200, body: { manifest: { lastIndexedAt: '2026-01-01' }, staleFileCount: 0 } }, directory).body;
    assert.equal(read().reindex.state, 'running'); assert.equal(read().reindex.progress.completedFiles, 1); assert.equal(read().reindex.progress.totalFiles, 2);
    assert.equal(read().reindex.progress.currentFile, 'src/a.ts');
    assert.equal((await managedUiReindex({ storePath: directory, onFinished() {} })).status, 409);
    assert.equal(read().reindex.id, result.body.runId); release(); await done;
    assert.equal(read().reindex.state, 'complete'); assert.ok(read().reindex.finishedAt);
}));

test('Проверка провайдера видна как starting, её ошибка завершает операцию безопасным сообщением', () => fixture(async directory => {
    let reject, entered, finished; const checking = new Promise(resolve => { entered = resolve; }), done = new Promise(resolve => { finished = resolve; });
    const work = managedUiReindex({ cwd: directory, storePath: directory, getEmbedder: () => { entered(); return new Promise((_, fail) => { reject = fail; }); }, onFinished: finished });
    await checking;
    const response = { status: 200, body: { manifest: { lastIndexedAt: null }, staleFileCount: 0 } };
    assert.equal(uiGuards.managedUiIndexingStatus(response, directory).body.reindex.state, 'starting');
    assert.equal(uiGuards.managedUiIndexingStatus(response, directory + '-other').body.reindex, null);
    reject(new Error('https://fixture.invalid secret-key=fixture-secret'));
    assert.equal((await work).status, 503); await done;
    const status = uiGuards.managedUiIndexingStatus(response, directory);
    assert.equal(status.body.reindex.state, 'failed'); assert.ok(status.body.reindex.finishedAt);
    assert.equal(JSON.stringify(status).includes('fixture-secret'), false);
}));

test('Отмена после started не становится успешным завершением', () => fixture(async directory => {
    let finished; const done = new Promise(resolve => { finished = resolve; });
    await managedUiReindex({ cwd: directory, storePath: directory, cfg: { embedding: { vectorDimension: 4 } }, store: {}, getEmbedder: async () => ({}),
        runIndexPass: ({ abortSignal }) => new Promise(resolve => abortSignal.addEventListener('abort', () => resolve({ embeddingFailures: 0 }), { once: true })), onFinished: finished });
    await closeManagedUiMutations(); await done;
    const status = uiGuards.managedUiIndexingStatus({ status: 200, body: { manifest: {} } }, directory);
    assert.equal(status.body.reindex.state, 'cancelled'); assert.ok(status.body.reindex.finishedAt);
}));

test('Сбой очистки кэша не теряет terminal status и не создаёт unhandled rejection', () => fixture(async directory => {
    let observed; const done = new Promise(resolve => { observed = resolve; });
    await managedUiReindex({ cwd: directory, storePath: directory, cfg: { embedding: { vectorDimension: 4 } }, store: {}, getEmbedder: async () => ({}),
        runIndexPass: async () => ({ embeddingFailures: 0 }), onFinished() { observed(); throw new Error('fixture cache observer failed'); } });
    await done;
    const status = uiGuards.managedUiIndexingStatus({ status: 200, body: { manifest: {} } }, directory);
    assert.equal(status.body.reindex.state, 'complete'); assert.ok(status.body.reindex.finishedAt);
}));

test('Первое явное сохранение создаёт минимальный конфиг, запуск его не создаёт', () => fixture(async directory => {
    const file = path.join(directory, 'opencode-rag.json');
    rememberUiConfig(directory, file);
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
    assert.equal(persistUiConfigPatch(file, { includeDirs: ['src'] }), null);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { indexing: { includeDirs: ['src'] } });
    assert.equal(persistUiConfigPatch(file, { excludeDirs: ['dist'] }), null);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).indexing, { includeDirs: ['src'], excludeDirs: ['dist'] });
}));

test('Сохранение сохраняет явный провайдер и ключ, внешний edit отклоняется без перезаписи', () => fixture(async directory => {
    const file = path.join(directory, 'opencode-rag.json');
    const original = { embedding: { model: 'fixture-model', apiKey: 'fixture-key' }, indexing: { includeDirs: ['src'] } };
    await fs.writeFile(file, JSON.stringify(original)); rememberUiConfig(directory, file);
    assert.equal(persistUiConfigPatch(file, { excludeDirs: ['dist'] }), null);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).embedding, original.embedding);
    const external = JSON.stringify({ ...original, indexing: { includeDirs: ['new-src'] } });
    await fs.writeFile(file, external);
    assert.equal(persistUiConfigPatch(file, { includeDirs: ['old-src'] }).status, 409);
    assert.equal(await fs.readFile(file, 'utf8'), external);
}));

test('Конкурирующее создание и подмена файла ссылкой не перезаписывают чужой конфиг', () => fixture(async directory => {
    const file = path.join(directory, 'opencode-rag.json'); rememberUiConfig(directory, file);
    await fs.writeFile(file, '{"external":true}', { flag: 'wx' });
    assert.equal(persistUiConfigPatch(file, { includeDirs: ['src'] }).status, 409);
    assert.equal(await fs.readFile(file, 'utf8'), '{"external":true}');
    const outside = path.join(directory, 'outside.json'); await fs.writeFile(outside, '{"outside":true}');
    rememberUiConfig(directory, file); await fs.unlink(file); await fs.symlink(outside, file);
    assert.equal(persistUiConfigPatch(file, { includeDirs: ['src'] }).status, 503);
    assert.equal(await fs.readFile(outside, 'utf8'), '{"outside":true}');
}));

test('Закрытие UI запрещает новые записи до ожидания текущего writer', () => fixture(async directory => {
    const own = await import('../adapters/rag-ui-guards.mjs?shutdown-proof');
    let started, finish; const entered = new Promise(resolve => { started = resolve; });
    const work = own.withManagedUiMutation(directory, async signal => {
        started(); await new Promise(resolve => { finish = resolve; signal.addEventListener('abort', () => {}, { once: true }); });
    });
    await entered; let closed = false;
    const close = own.closeManagedUiMutations({ shutdown: true }).then(() => { closed = true; });
    await assert.rejects(own.withManagedUiMutation(directory, async () => {}), error => error.statusCode === 503);
    assert.equal(closed, false); finish(); await work; await close;
    assert.equal(closed, true);
    await assert.rejects(fs.access(path.join(directory, 'neurocenter-session.lock')), { code: 'ENOENT' });
}));
