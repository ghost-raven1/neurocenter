import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withManagedIndexProfile, requireManagedIndexProfile } from '../adapters/rag-index-profile.mjs';
import { acquireManagedIndexLock, releaseManagedIndexLock, enterManagedSession, leaveManagedSessions, preserveManagedSessionLock } from '../adapters/rag-index-lock.mjs';

async function fixture(action) {
    const storePath = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-index-profile-'));
    const config = { embedding: { provider: 'ollama', model: 'fixture-a', baseUrl: 'http://localhost:11435/api', vectorDimension: 4 } };
    const options = { config, storePath, dimension: 4, embedder: { model: 'fixture-a' }, store: { count: async () => 2 } };
    const sidecar = () => fs.readFile(path.join(storePath, 'neurocenter-index-profile.json'), 'utf8').then(JSON.parse);
    const success = async () => {
        await fs.writeFile(path.join(storePath, 'manifest.json'), JSON.stringify({ lastIndexedAt: Date.now() }));
        return { finalCount: 2, extractionFailures: 0, descriptionFailedFiles: 0, embeddingFailures: 0 };
    };
    try { await action({ options, sidecar, success, storePath }); }
    finally { await fs.rm(storePath, { recursive: true, force: true }); }
}

test('Непроверенный существующий индекс перестраивается, повторный проход сохраняет incremental', async () => fixture(async ({ options, sidecar, success }) => {
    await withManagedIndexProfile(options, async next => { assert.equal(next.force, true); assert.equal((await sidecar()).state, 'indexing'); return success(); });
    assert.equal((await sidecar()).state, 'ready');
    await withManagedIndexProfile(options, async next => { assert.equal(next.force, false); return success(); });
    await requireManagedIndexProfile(options.store, options.storePath, options.config, 4, options.embedder);
}));

test('Другая модель той же размерности блокирует поиск до атомарного полного rebuild', async () => fixture(async ({ options, success }) => {
    await withManagedIndexProfile(options, success);
    const changed = { ...options, config: { embedding: { ...options.config.embedding, model: 'fixture-b' } }, embedder: { model: 'fixture-b' } };
    await assert.rejects(requireManagedIndexProfile(changed.store, changed.storePath, changed.config, 4, changed.embedder), /перезапустите/);
    await withManagedIndexProfile(changed, async next => { assert.equal(next.force, true); return success(); });
    await requireManagedIndexProfile(changed.store, changed.storePath, changed.config, 4, changed.embedder);
}));

for (const problem of [{ embeddingFailures: 1 }, { embeddingUnavailable: true }, { extractionFailures: 1 }, { descriptionFailedFiles: 1 }, { skipped: true }]) {
    test('Частичный проход не подтверждает профиль: ' + JSON.stringify(problem), async () => fixture(async ({ options, sidecar, success }) => {
        await assert.rejects(withManagedIndexProfile(options, async () => ({ ...await success(), ...problem })), /Ошибка локального индекса/);
        assert.equal((await sidecar()).state, 'failed');
        await assert.rejects(requireManagedIndexProfile(options.store, options.storePath, options.config, 4, options.embedder));
    }));
}

test('Старый manifest, abort и исключение не превращаются в ready', async () => fixture(async ({ options, sidecar, success, storePath }) => {
    await fs.writeFile(path.join(storePath, 'manifest.json'), JSON.stringify({ lastIndexedAt: 1 }));
    await assert.rejects(withManagedIndexProfile(options, async () => ({ finalCount: 2 })), /Ошибка локального индекса/);
    const abort = new AbortController();abort.abort();
    await assert.rejects(withManagedIndexProfile({ ...options, abortSignal: abort.signal }, success), /Ошибка локального индекса/);
    await assert.rejects(withManagedIndexProfile(options, async () => { throw new Error('fixture failure'); }), /fixture failure/);
    assert.equal((await sidecar()).state, 'failed');
}));

test('Runtime overrides не подписывают старый embedder новой моделью', async () => fixture(async ({ options, sidecar, success, storePath }) => {
    await withManagedIndexProfile(options, success);
    await fs.writeFile(path.join(storePath, 'runtime-overrides.json'), JSON.stringify({ embedding: { model: 'fixture-b' } }));
    let ran = false;
    await assert.rejects(withManagedIndexProfile(options, async () => { ran = true; }), /перезапустите/);
    assert.equal(ran, false);
    await assert.rejects(requireManagedIndexProfile(options.store, storePath, options.config, 4, options.embedder), /перезапустите/);
    assert.equal((await sidecar()).profile.model, 'fixture-a');
    await fs.rm(path.join(storePath, 'runtime-overrides.json'));
    await assert.rejects(withManagedIndexProfile({ ...options, embedder: { model: 'wrong' } }, success), /перезапустите/);
}));

test('Пустой store не требует sidecar и не вызывает embedder', async () => fixture(async ({ options }) => {
    await requireManagedIndexProfile({ count: async () => 0 }, options.storePath, options.config, 4, { get model() { throw new Error('called'); } });
}));

test('Два претендента не затирают lock; release не удаляет чужой token', async () => fixture(async ({ storePath }) => {
    const file = path.join(storePath, 'index.lock');
    const results = await Promise.all([acquireManagedIndexLock(file), acquireManagedIndexLock(file)]);
    assert.deepEqual(results.sort(), [false, true]);
    const owned = JSON.parse(await fs.readFile(file));
    await fs.writeFile(file, JSON.stringify({ ...owned, owner: 'another-owner' }));
    await releaseManagedIndexLock(file);
    assert.equal(JSON.parse(await fs.readFile(file)).owner, 'another-owner');
}));

test('Конкурентное восстановление dead-PID lock выдаёт ровно одного нового владельца', async () => fixture(async ({ storePath }) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const pid = child.pid;await once(child, 'exit');
    const file = path.join(storePath, 'index.lock');
    await fs.writeFile(file, JSON.stringify({ pid, startedAt: 1 }));
    const results = await Promise.all(Array.from({ length: 8 }, () => acquireManagedIndexLock(file)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(JSON.parse(await fs.readFile(file)).pid, process.pid);
    await releaseManagedIndexLock(file);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
}));

test('Native presence удерживается при reload и rebuild, освобождается после shutdown', async () => fixture(async ({ storePath }) => {
    await enterManagedSession(storePath);await enterManagedSession(storePath);
    const file = path.join(storePath, 'neurocenter-session.lock');
    const bytes = await fs.readFile(file, 'utf8');
    const temp = path.join(storePath, 'temp');await fs.mkdir(temp);
    await preserveManagedSessionLock(storePath, temp);
    assert.equal(await fs.readFile(path.join(temp, 'neurocenter-session.lock'), 'utf8'), bytes);
    await leaveManagedSessions();await assert.rejects(fs.stat(file), { code: 'ENOENT' });
}));

test('Native presence не открывает store во время bridge restore', async () => fixture(async ({ storePath }) => {
    await fs.writeFile(path.join(storePath, 'index.lock'), JSON.stringify({ pid: process.pid, owner: 'bridge-fixture' }));
    await assert.rejects(enterManagedSession(storePath), /восстановление/);
    await assert.rejects(fs.stat(path.join(storePath, 'neurocenter-session.lock')), { code: 'ENOENT' });
}));
