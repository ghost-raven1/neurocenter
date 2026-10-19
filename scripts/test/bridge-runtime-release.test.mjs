import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {bridgeRuntimeCached, hydrateBridgeRuntimeRelease, publishBridgeRuntimeFiles, validateBridgeRuntimeRelease} from '../bridge-runtime-release.mjs';
import {opencodeVersion} from '../opencode-platforms.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const version = '9.8.7', buildId = 'b'.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-release-'));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const output = path.join(directory, 'bridge-dist/runtime'), payloads = new Map(), calls = [];
    const artifacts = ['darwin-arm64', 'linux-x64'].map(target => {
        const file = `neurocenter-asset-sync-${target}-${version}.tgz`, bytes = Buffer.from(`isolated pinned runtime ${target}`);
        const url = `https://github.com/ghost-raven1/neurocenter/releases/download/bridge-v${version}/${file}`;
        payloads.set(url, bytes);
        return {file, url, metadata: {version, buildId, target, nodeVersion: '24.22.0', ragSupported: true,
            probeEngine: {version: opencodeVersion, file: 'bin/opencode-probe', sha256: 'a'.repeat(64)}, sha256: sha(bytes), bytes: bytes.length}};
    });
    const release = {schemaVersion: 1, version, buildId, release: `bridge-v${version}`, artifacts};
    await fs.mkdir(path.join(directory, 'mcp/neurocenter-asset-sync'), {recursive: true});
    await fs.mkdir(path.join(directory, 'scripts'), {recursive: true});
    await fs.writeFile(path.join(directory, 'mcp/neurocenter-asset-sync/package.json'), JSON.stringify({version}));
    await fs.writeFile(path.join(directory, 'scripts/bridge-runtime-release.json'), JSON.stringify(release));
    const fetch = async (url, options) => { calls.push({url, options}); return new Response(payloads.get(url), {status: 200}); };
    const hydrate = options => hydrateBridgeRuntimeRelease({directory, fetch, ...options});
    const read = async artifact => Promise.all(['', '.json', '.sha256'].map(suffix => fs.readFile(path.join(output, artifact.file + suffix))));
    return {directory, output, release, payloads, calls, fetch, hydrate, read};
}

test('Поставка без dist и npm загружает два закреплённых архива и повторяет запуск без сети', async t => {
    const f = await fixture(t), result = await f.hydrate();
    assert.deepEqual(result.downloaded, ['darwin-arm64','linux-x64']);
    assert.equal(f.calls.length, 2);
    for (const artifact of f.release.artifacts) {
        assert.deepEqual(await f.read(artifact), [f.payloads.get(artifact.url), Buffer.from(JSON.stringify(artifact.metadata, null, 2) + '\n'), Buffer.from(artifact.metadata.sha256 + '\n')]);
        assert.equal(await bridgeRuntimeCached({directory: f.output, target: artifact.metadata.target, version, buildId, metadata: artifact.metadata}), true);
    }
    assert.deepEqual((await f.hydrate()).downloaded, []); assert.equal(f.calls.length, 2);
    await assert.rejects(fs.access(path.join(f.directory, '.run/bridge-runtimes.lock')), {code: 'ENOENT'});
});

test('Явный выбор платформы не скачивает остальные архивы', async t => {
    const f = await fixture(t);
    assert.deepEqual((await f.hydrate({targets: ['linux-x64']})).targets, ['linux-x64']);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, f.release.artifacts[1].url);
    await assert.rejects(fs.access(path.join(f.output, f.release.artifacts[0].file)), {code: 'ENOENT'});
});

test('Несовпадение версии корневого пакета запрещает загрузку старого release', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.directory, 'mcp/neurocenter-asset-sync/package.json'), JSON.stringify({version: '9.8.8'}));
    await assert.rejects(f.hydrate(), /Версия пакета/); assert.equal(f.calls.length, 0);
});

test('Опись отклоняет подмену версии, сборки, URL, размера и повтор цели', async t => {
    const f = await fixture(t);
    for (const mutate of [
        value => { value.artifacts[0].metadata.buildId = 'c'.repeat(64); },
        value => { value.artifacts[0].metadata.version = '9.8.6'; },
        value => { value.artifacts[0].url = value.artifacts[0].url.replace('https:', 'http:'); },
        value => { value.artifacts[0].url = value.artifacts[0].url.replace('ghost-raven1', 'another-owner'); },
        value => { value.artifacts[0].metadata.bytes = 1024 ** 3 + 1; },
        value => { value.artifacts.push(value.artifacts[0]); },
    ]) { const bad = clone(f.release); mutate(bad); assert.throws(() => validateBridgeRuntimeRelease(bad)); }
});

test('Повреждённый локальный sidecar восстанавливается только из закреплённой описи', async t => {
    const f = await fixture(t); await f.hydrate(); const artifact = f.release.artifacts[0];
    const bad = {...artifact.metadata, buildId: 'f'.repeat(64)};
    await fs.writeFile(path.join(f.output, artifact.file + '.json'), JSON.stringify(bad));
    assert.deepEqual((await f.hydrate()).downloaded, ['darwin-arm64']); assert.equal(f.calls.length, 3);
    assert.deepEqual(JSON.parse((await f.read(artifact))[1].toString()), artifact.metadata);
});

for (const mode of ['sha','oversize','short','length','redirect','http']) {
    test(`Сбой загрузки (${mode}) сохраняет весь прежний комплект`, async t => {
        const f = await fixture(t); await f.hydrate();
        const before = await Promise.all(f.release.artifacts.map(f.read));
        const changed = clone(f.release);
        // Прежние корректные файлы сохраняются, пока поставка другой SHA не пройдёт целиком.
        changed.artifacts.forEach(item => { item.metadata.sha256 = 'f'.repeat(64); });
        let count = 0;
        const fetch = async url => {
            count++;
            if (mode === 'redirect') return new Response(null, {status: 302, headers: {location: 'https://example.org/archive'}});
            if (mode === 'http') return new Response(null, {status: 302, headers: {location: 'http://github.com/archive'}});
            const bytes = f.payloads.get(url);
            if (mode === 'oversize') return new Response(Buffer.concat([bytes, Buffer.from('extra')]));
            if (mode === 'short') return new Response(bytes.subarray(1));
            if (mode === 'length') return new Response(bytes, {headers: {'content-length': String(bytes.length + 1)}});
            return new Response(bytes);
        };
        await assert.rejects(f.hydrate({release: changed, fetch}), /SHA-256|размер|Размер|HTTPS GitHub/);
        assert.equal(count, 1); assert.deepEqual(await Promise.all(f.release.artifacts.map(f.read)), before);
        assert.equal((await fs.readdir(f.output)).some(file => file.startsWith('.bridge-release-')), false);
        await assert.rejects(fs.access(path.join(f.directory, '.run/bridge-runtimes.lock')), {code: 'ENOENT'});
    });
}

test('Публикация откатывает весь комплект при сбое rename второго архива', async t => {
    const f = await fixture(t); await f.hydrate(); const before = await Promise.all(f.release.artifacts.map(f.read));
    const next = clone(f.release);
    const nextPayload = new Map();
    next.artifacts.forEach(artifact => {
        const bytes = Buffer.from('next release bytes ' + artifact.metadata.target);
        artifact.metadata.bytes = bytes.length; artifact.metadata.sha256 = sha(bytes); nextPayload.set(artifact.url, bytes);
    });
    const rename = fs.rename; let failed = false;
    const publish = async options => {
        fs.rename = async (source, destination) => {
            if (!failed && source.includes('/result/') && source.endsWith(next.artifacts[1].file + '.json')) {
                failed = true; throw Object.assign(new Error('fixture ENOSPC'), {code: 'ENOSPC'});
            }
            return rename(source, destination);
        };
        try { await publishBridgeRuntimeFiles(options); } finally { fs.rename = rename; }
    };
    await assert.rejects(f.hydrate({release: next, fetch: async url => new Response(nextPayload.get(url)), publish}), /ENOSPC/);
    assert.equal(failed, true); assert.deepEqual(await Promise.all(f.release.artifacts.map(f.read)), before);
});

test('Чужая блокировка сохраняется; полностью проверенный кеш доступен без её удаления', async t => {
    const f = await fixture(t), lock = path.join(f.directory, '.run/bridge-runtimes.lock');
    await fs.mkdir(lock, {recursive: true}); await fs.writeFile(path.join(lock, 'owner'), 'another preparation');
    await assert.rejects(f.hydrate(), /уже выполняется/); assert.equal(f.calls.length, 0);
    assert.equal(await fs.readFile(path.join(lock, 'owner'), 'utf8'), 'another preparation');
    await fs.rm(lock, {recursive: true}); await f.hydrate();
    await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner'), 'keep');
    assert.deepEqual((await f.hydrate()).downloaded, []);
    assert.equal(await fs.readFile(path.join(lock, 'owner'), 'utf8'), 'keep');
});

test('Production build готовит раздачу до Docker COPY и останавливается при отказе загрузки', async t => {
    const f = await fixture(t), scripts = path.join(f.directory, 'scripts/production'), config = path.join(f.directory, 'config');
    await fs.mkdir(scripts); await fs.mkdir(config); await fs.writeFile(path.join(config, '.env'), 'FIXTURE=true');
    await fs.copyFile(path.join(repository, 'scripts/production/setup.mjs'), path.join(scripts, 'setup.mjs'));
    await fs.writeFile(path.join(scripts, 'configuration.mjs'), 'export const ensureMetricsToken=async()=>{};export const configureProduction=async()=>{};');
    await fs.writeFile(path.join(scripts, 'sync-catalog.mjs'), 'export const runCatalogSync=async()=>{};');
    await fs.writeFile(path.join(scripts, 'sync-models.mjs'), 'export const runModelBundleSync=async()=>{};');
    const events = path.join(f.directory, 'events.jsonl');
    await fs.writeFile(path.join(scripts, 'compose-client.mjs'), `import fs from 'node:fs';export const composeClient=()=>({run:async command=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(command)+'\\n')});export const composeConfiguration=async()=>{};export const maintenanceLock=async()=>{};`);
    await fs.writeFile(path.join(f.directory, 'scripts/bridge-runtime-release.mjs'), `import fs from 'node:fs';export const hydrateBridgeRuntimeRelease=async()=>{fs.appendFileSync(${JSON.stringify(events)},JSON.stringify('hydrate')+'\\n');if(process.env.FIXTURE_FAIL)throw Error('fixture hydration failed');return {version:'9.8.7',targets:['darwin-arm64','linux-x64'],downloaded:[]};};`);
    const run = fail => spawnSync(process.execPath, [path.join(scripts, 'setup.mjs'), 'build', '--directory', config], {encoding: 'utf8', env: {...process.env, FIXTURE_FAIL: fail ? '1' : ''}});
    const success = run(false); assert.equal(success.status, 0, success.stderr);
    assert.deepEqual((await fs.readFile(events, 'utf8')).trim().split('\n').map(JSON.parse), ['hydrate',['build']]);
    await fs.rm(events); const failed = run(true); assert.equal(failed.status, 1); assert.match(failed.stderr, /hydration failed/);
    assert.deepEqual((await fs.readFile(events, 'utf8')).trim().split('\n').map(JSON.parse), ['hydrate']);
});
