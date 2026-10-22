import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {packageBridgeOpenCodeSdk, readBridgeSdkLock, validateBridgeSdkManifest, verifyBridgeSdkArchive, sdkSourceLockSha256} from '../bridge-runtime-sdk.mjs';
import {bridgeSdkFixture, sdkTarFixture} from './bridge-runtime-sdk.fixture.mjs';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const target = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}${process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : ''}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc SDK fixture ')));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const stage = path.join(root, 'stage'), content = path.join(stage, 'package');
    await fs.mkdir(path.join(content, 'bin'), {recursive: true}); await fs.mkdir(path.join(root, 'scripts'));
    await fs.copyFile(path.join(repository, 'scripts/bridge-opencode-sdk-lock.json'), path.join(root, 'scripts/bridge-opencode-sdk-lock.json'));
    const npm = path.join(root, 'fixture-npm.js'); await fs.writeFile(npm, '');
    const environment = {PATH: process.env.PATH, NPM_CLI_JS: npm, NPM_TOKEN: 'owned-secret-sentinel', npm_config_registry: 'https://user-private.invalid'};
    const calls = [];
    const run = async (node, args, options) => {
        calls.push({node, args, ...options});
        if (args[1] === 'ci') {
            const lock = JSON.parse(await fs.readFile(path.join(options.cwd, 'package-lock.json'), 'utf8'));
            for (const [name, entry] of Object.entries(lock.packages)) if (name) {
                const directory = path.join(options.cwd, name); await fs.mkdir(directory, {recursive: true});
                await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({name: name.split('node_modules/').at(-1), version: entry.version, dependencies: entry.dependencies}));
                await fs.writeFile(path.join(directory, 'index.js'), '// complete synthetic package body\n');
            }
        }
        return '{}';
    };
    const build = dependencies => packageBridgeOpenCodeSdk({root, content, stage, target}, {run, environment, ...dependencies});
    return {root, stage, content, npm, environment, calls, run, build};
}

test('SDK producer preserves independent bridge dependencies and carries the real full lock with nested packages', async t => {
    const f = await fixture(t), manual = path.join(f.content, 'node_modules/zod/package.json');
    await fs.mkdir(path.dirname(manual), {recursive: true}); await fs.writeFile(manual, '{"name":"zod","version":"3.25.76","manual":true}\n');
    const before = await fs.readFile(manual), manifest = await f.build(), seed = path.join(f.content, 'bin/opencode-sdk');
    assert.equal(manifest.version, '1.14.48'); assert.equal(manifest.sourceLockSha256, sdkSourceLockSha256);
    assert.equal(JSON.parse(await fs.readFile(path.join(seed, 'package/node_modules/zod/package.json'), 'utf8')).version, '4.1.8');
    assert.deepEqual(await fs.readFile(manual), before);
    const source = JSON.parse(await fs.readFile(path.join(seed, 'source-lock.json'), 'utf8')), nested = JSON.parse(await fs.readFile(path.join(seed, 'lock-entries.json'), 'utf8'));
    assert.equal(Object.keys(source.packages).length - 1, 30); assert.equal(Object.keys(nested.packages).length, 30);
    assert.deepEqual(nested.packages['node_modules/@opencode-ai/plugin/node_modules/zod'], source.packages['node_modules/zod']);
    assert.ok(f.calls[0].args.includes('--ignore-scripts')); assert.ok(f.calls[0].args.includes('--no-bin-links'));
    assert.ok(f.calls[1].args.includes('--offline')); assert.equal(f.calls[0].env.NPM_TOKEN, undefined); assert.equal(f.calls[0].env.npm_config_registry, undefined);
    assert.notEqual(f.calls[0].env.HOME, os.homedir()); assert.ok(f.calls[0].args.includes('--registry=https://registry.npmjs.org/'));
    await assert.rejects(fs.access(f.calls[0].env.HOME), {code: 'ENOENT'}); await assert.rejects(fs.access(path.join(f.stage, 'sdk-install')), {code: 'ENOENT'});
    const files = new Map();
    for (const item of [...manifest.files, {path: 'manifest.json'}]) files.set('bin/opencode-sdk/' + item.path, await fs.readFile(path.join(seed, item.path)));
    const archive = path.join(f.root, 'built-sdk.tgz'); await fs.writeFile(archive, sdkTarFixture(files));
    assert.deepEqual(await verifyBridgeSdkArchive(archive, target), manifest);
});

for (const code of ['ENOTCACHED', 'ECONNREFUSED', 'E403']) test('Only structured unavailable SDK npm failure defers: ' + code, async t => {
    const f = await fixture(t);
    await assert.rejects(f.build({run() { throw Object.assign(Error('private diagnostic must not escape'), {status: 1, stdout: JSON.stringify({error: {code, detail: 'owned-secret-sentinel'}})}); }}), error => {
        assert.equal(error.code, 'SDK_UNAVAILABLE'); assert.doesNotMatch(error.message, /sentinel|private diagnostic/); return true;
    });
    assert.deepEqual(await fs.readdir(path.join(f.content, 'bin')), []); await assert.rejects(fs.access(path.join(f.stage, 'sdk-install')), {code: 'ENOENT'});
});

for (const failure of [
    {status: 1, stdout: JSON.stringify({error: {code: 'EINTEGRITY'}})},
    {status: 1, stdout: JSON.stringify({error: {code: 'EJSONPARSE'}})},
    {status: 75, stdout: 'SDK_UNAVAILABLE'},
    {status: null, signal: 'SIGTERM', stdout: JSON.stringify({error: {code: 'ETIMEDOUT'}})},
    {code: 'ETIMEDOUT', stdout: JSON.stringify({error: {code: 'ETIMEDOUT'}})},
]) test('Fatal npm/cancellation output never becomes optional SDK unavailability: ' + JSON.stringify(failure), async t => {
    const f = await fixture(t);
    await assert.rejects(f.build({run() { throw Object.assign(Error('secret output'), failure); }}), error => { assert.notEqual(error.code, 'SDK_UNAVAILABLE'); assert.doesNotMatch(error.message, /secret output/); return true; });
});

test('Missing npm defers while a changed source lock fails integrity before any npm command', async t => {
    const f = await fixture(t);
    await assert.rejects(f.build({environment: {PATH: ''}}), {code: 'SDK_UNAVAILABLE', reason: 'missing-npm'});
    await fs.appendFile(path.join(f.root, 'scripts/bridge-opencode-sdk-lock.json'), ' ');
    await assert.rejects(f.build(), /SHA-256/); assert.equal(f.calls.length, 0);
});

test('An occupied seed path is preserved and an incomplete mandatory closure never publishes a manifest', async t => {
    const f = await fixture(t), seed = path.join(f.content, 'bin/opencode-sdk'); await fs.mkdir(seed); await fs.writeFile(path.join(seed, 'manual'), 'foreign');
    await assert.rejects(f.build(), {code: 'EEXIST'}); assert.equal(await fs.readFile(path.join(seed, 'manual'), 'utf8'), 'foreign');
    await fs.rm(seed, {recursive: true});
    await assert.rejects(f.build({run: async (node, args, options) => { await f.run(node, args, options); if (args[1] === 'ci') await fs.rm(path.join(options.cwd, 'node_modules/zod'), {recursive: true}); }}));
    await assert.rejects(fs.access(path.join(seed, 'manifest.json')), {code: 'ENOENT'});
});

test('Source lock rejects symbolic links without following or replacing them', async t => {
    const f = await fixture(t), lock = path.join(f.root, 'scripts/bridge-opencode-sdk-lock.json'), saved = lock + '.saved';
    await fs.rename(lock, saved); await fs.symlink(saved, lock);
    await assert.rejects(readBridgeSdkLock(f.root), /lock/); assert.equal(hash(await fs.readFile(saved)), sdkSourceLockSha256);
});

for (const optional of ['msgpackr-extract', 'detect-libc', 'node-gyp-build-optional-packages', '@msgpackr-extract/msgpackr-extract-' + (process.platform === 'win32' ? 'win32' : process.platform) + '-' + process.arch]) {
    test('A target-selected optional dependency is required by producer and archive: ' + optional, async t => {
        const f = await fixture(t), key = 'node_modules/' + optional, {lock} = await readBridgeSdkLock(f.root);
        if (!lock.packages[key]) { assert.equal(target, 'windows-arm64'); return; }
        await assert.rejects(f.build({run: async (node, args, options) => { await f.run(node, args, options); if (args[1] === 'ci') await fs.rm(path.join(options.cwd, key), {recursive: true}); }}));
        const archive = path.join(f.root, 'missing-optional.tgz'); await fs.writeFile(archive, (await bridgeSdkFixture(target, {omitPackages: [key]})).bytes);
        await assert.rejects(verifyBridgeSdkArchive(archive, target), /полного набора/);
    });
}

for (const value of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linux-arm64-musl', 'linux-x64-musl', 'windows-arm64', 'windows-x64']) {
    test('Synthetic metadata closure permits only foreign optional packages to be absent: ' + value, async t => {
        const f = await fixture(t), {lock} = await readBridgeSdkLock(f.root), [platform, cpu] = value.split('-'), os = platform === 'windows' ? 'win32' : platform;
        const omitPackages = Object.entries(lock.packages).filter(([, item]) => item.optional && (item.os && !item.os.includes(os) || item.cpu && !item.cpu.includes(cpu))).map(([name]) => name);
        const archive = path.join(f.root, 'target-metadata.tgz'); await fs.writeFile(archive, (await bridgeSdkFixture(value, {omitPackages})).bytes);
        assert.equal((await verifyBridgeSdkArchive(archive, value)).target, value);
    });
}

test('Archive reads require an ordinary bounded file and the exact expected compressed bytes', async t => {
    const f = await fixture(t), archive = path.join(f.root, 'bounded.tgz'), {bytes} = await bridgeSdkFixture(target); await fs.writeFile(archive, bytes);
    await assert.rejects(verifyBridgeSdkArchive(archive, target, {bytes: bytes.length + 1}), /Недопустимый архив/);
    await assert.rejects(verifyBridgeSdkArchive(archive, target, {sha256: '0'.repeat(64)}), /закреплёнными байтами/);
    await fs.symlink(archive, archive + '.link'); await assert.rejects(verifyBridgeSdkArchive(archive + '.link', target));
    await fs.truncate(archive, 1024 ** 3 + 1); await assert.rejects(verifyBridgeSdkArchive(archive, target), /Недопустимый архив/);
});

test('SDK metadata capture has an aggregate bound before manifest reconciliation', async t => {
    const f = await fixture(t), archive = path.join(f.root, 'capture.tgz'), {files} = await bridgeSdkFixture(target);
    for (let index = 0; index < 5; index++) files.set(`bin/opencode-sdk/package/extra-${index}/package.json`, Buffer.from(' '.repeat(1024 ** 2 - 2) + '{}'));
    await fs.writeFile(archive, sdkTarFixture(files)); await assert.rejects(verifyBridgeSdkArchive(archive, target), /Метаданные архива SDK превышают предел/);
});

for (const [name, change] of [
    ['version', value => { value.version = '1.14.47'; }], ['target', value => { value.target = 'linux-x64'; }],
    ['unknown field', value => { value.auth = 'ignored'; }], ['lock pin', value => { value.sourceLockSha256 = 'a'.repeat(64); }],
    ['bytes', value => { value.bytes++; }], ['bounds', value => { value.bytes = 128 * 1024 ** 2 + 1; }],
    ['traversal', value => { value.files[0].path = '../foreign'; }], ['duplicate', value => { value.files[1].path = value.files[0].path; }],
    ['missing entry', value => { value.files.pop(); }], ['unsorted', value => { value.files.reverse(); }],
]) test('SDK manifest rejects ' + name, async () => {
    const {manifest} = await bridgeSdkFixture('darwin-arm64'); change(manifest); assert.throws(() => validateBridgeSdkManifest(manifest, 'darwin-arm64'));
});

for (const [name, options] of [
    ['missing seed', {seed: false}],
    ['wrong native version', {changeManifest: value => { value.openCodeVersion = '1.0.0'; }}],
    ['payload tamper', {changeFiles: files => files.set('bin/opencode-sdk/package/index.js', Buffer.from('tampered'))}],
    ['extra payload', {changeFiles: files => files.set('bin/opencode-sdk/package/foreign', Buffer.from('foreign'))}],
    ['missing closure package', {changeFiles: files => files.delete('bin/opencode-sdk/package/node_modules/zod/package.json')}],
    ['malformed JSON', {changeFiles: files => files.set('bin/opencode-sdk/manifest.json', Buffer.from('{'))}],
]) test('SHA-valid runtime archive rejects ' + name, async t => {
    const f = await fixture(t), archive = path.join(f.root, 'candidate.tgz'); await fs.writeFile(archive, (await bridgeSdkFixture(target, options)).bytes);
    await assert.rejects(verifyBridgeSdkArchive(archive, target));
});

for (const [name, type] of [['bin/opencode-sdk', {type: '2', linkpath: 'foreign'}], ['bin/opencode-sdk/../foreign/', {type: '5'}],
    ['bin/opencode-sdk/package/index.js/', {type: '5'}], ['./bin/opencode-sdk/package/index.js', {type: '0'}],
    ['BIN', {type: '2', linkpath: 'foreign'}], ['bin/OPENCODE-SDK', {type: '2', linkpath: 'foreign'}],
    ['BIN/opencode-sdk/package/index.js', {type: '0'}], ['bin/OPENCODE-SDK/package/index.js', {type: '0'}]]) {
    test('SDK topology rejects an extra root/link/directory/alias entry: ' + name, async t => {
        const f = await fixture(t), archive = path.join(f.root, 'topology.tgz'), {files} = await bridgeSdkFixture(target);
        files.set(name, Buffer.alloc(0)); await fs.writeFile(archive, sdkTarFixture(files, {types: {[name]: type}}));
        await assert.rejects(verifyBridgeSdkArchive(archive, target));
    });
}

for (const name of ['bin\\opencode-sdk/package/index.js', 'BIN\\OPENCODE-SDK']) test('Synthetic Windows target rejects raw backslash SDK aliases: ' + name, async t => {
    const f = await fixture(t), archive = path.join(f.root, 'windows-alias.tgz'), {files} = await bridgeSdkFixture('windows-x64');
    files.set(name, Buffer.alloc(0)); await fs.writeFile(archive, sdkTarFixture(files, {types: {[name]: {type: '2', linkpath: 'foreign'}}}));
    await assert.rejects(verifyBridgeSdkArchive(archive, 'windows-x64'));
});

for (const [mode, expected] of [['E403', 75], ['missing-npm', 75], ['EINTEGRITY', 1], ['child75', 1], ['signal', 1]]) test('Real packager subprocess reserves exit75 only for typed SDK failure: ' + mode, async t => {
    const f = await fixture(t);
    for (const file of ['package-bridge-runtime.mjs', 'bridge-runtime-sdk.mjs', 'bridge-build-integrity.mjs', 'bridge-runtime-probe.mjs', 'bridge-windows-job.mjs', 'opencode-platforms.mjs', 'workspace/node-runtime.mjs', 'workspace/npm-build-environment.mjs']) {
        await fs.mkdir(path.dirname(path.join(f.root, 'scripts', file)), {recursive: true});
        await fs.copyFile(path.join(repository, 'scripts', file), path.join(f.root, 'scripts', file));
    }
    const bridge = path.join(f.root, 'mcp/neurocenter-asset-sync'), output = path.join(f.root, 'published'); await fs.mkdir(path.join(bridge, 'dist'), {recursive: true}); await fs.mkdir(output);
    await fs.writeFile(path.join(bridge, 'package.json'), '{"name":"neurocenter-asset-sync","version":"9.8.7"}\n');
    await fs.writeFile(path.join(bridge, 'package-lock.json'), '{}'); await fs.writeFile(path.join(bridge, 'dist/index.js'), 'owned fixture');
    await fs.writeFile(path.join(bridge, 'dist/build.json'), JSON.stringify({version: '9.8.7', buildId: hash('index.js\0owned fixture')}));
    await fs.writeFile(path.join(output, 'previous'), 'previous archive and pointer must remain');
    await fs.writeFile(f.npm, mode === 'signal' ? 'process.kill(process.pid,"SIGTERM");' : mode === 'child75' ? 'process.exit(75);' : `console.log(JSON.stringify({error:{code:${JSON.stringify(mode)},detail:'owned-secret-sentinel'}}));process.exit(1);`);
    const result = spawnSync(process.execPath, [path.join(f.root, 'scripts/package-bridge-runtime.mjs')], {cwd: f.root,
        env: {...process.env, PATH: mode === 'missing-npm' ? '' : process.env.PATH, npm_execpath: undefined, NPM_CLI_JS: mode === 'missing-npm' ? undefined : f.npm, BRIDGE_RUNTIME_OUTPUT_DIR: output}, encoding: 'utf8', timeout: 10000});
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, expected, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /owned-secret-sentinel/); if (expected === 75) assert.match(result.stderr, mode === 'missing-npm' ? /missing-npm/ : /registry-unavailable/);
    assert.deepEqual(await fs.readdir(output), ['previous']); assert.equal(await fs.readFile(path.join(output, 'previous'), 'utf8'), 'previous archive and pointer must remain');
});
