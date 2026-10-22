import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {test, mock} from 'node:test';
import {prepareDevBridge, devBridgeTarget} from '../workspace/dev-bridge-runtime.mjs';
import {opencodeVersion} from '../opencode-platforms.mjs';

/** Real filesystem publication, with build/download subprocesses replaced before any network or home access. */
async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dev bridge source ')));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const bridge = path.join(root, 'mcp/neurocenter-asset-sync'), runtime = path.join(root, '.run/dev-bridge/runtime');
    await fs.mkdir(path.join(bridge, 'dist'), {recursive: true});
    // rev-parse only needs the checkout's existing HEAD; no real user Git configuration is read.
    await fs.mkdir(path.join(root, '.git/refs/heads'), {recursive: true});
    await fs.mkdir(path.join(root, '.git/objects'));
    await fs.writeFile(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(root, '.git/refs/heads/main'), '1'.repeat(40) + '\n');
    await fs.writeFile(path.join(bridge, 'package.json'), JSON.stringify({version: '0.9.18'}));
    const index = 'current checkout source\n';
    const buildId = createHash('sha256').update('index.js\0').update(index).digest('hex');
    const calls = [], state = {fail: undefined, corrupt: false, updates: 0};
    const run = async (node, args, options) => {
        const script = path.basename(args[0]); calls.push({node, script, ...options});
        if (state.fail === script) throw new Error('synthetic ENOSPC/build failure');
        if (script === 'build.mjs') {
            await fs.writeFile(path.join(bridge, 'dist/index.js'), index);
            await fs.writeFile(path.join(bridge, 'dist/build.json'), JSON.stringify({version: '0.9.18', buildId}));
        } else if (script === 'package-bridge-runtime.mjs') {
            const name = `neurocenter-asset-sync-${devBridgeTarget()}-0.9.18.tgz`, bytes = Buffer.from('fresh production dependencies and bundled Node');
            const sha256 = createHash('sha256').update(bytes).digest('hex'), archive = path.join(options.env.BRIDGE_RUNTIME_OUTPUT_DIR, name);
            await fs.writeFile(archive, state.corrupt ? Buffer.from('corrupt') : bytes);
            await fs.writeFile(archive + '.sha256', sha256 + '\n');
            await fs.writeFile(archive + '.json', JSON.stringify({version: '0.9.18', target: devBridgeTarget(), buildId,
                nodeVersion: process.versions.node, probeEngine: {version: opencodeVersion}, bytes: bytes.length, sha256}));
        }
    };
    const updateInstalled = async options => { state.updates++; state.updateOptions = options; if (state.fail === 'update') throw new Error('offline paired bridge'); return {updated: true}; };
    const execute = (options = {}) => prepareDevBridge({root, run, environment: {PATH: process.env.PATH, OPENCODE_TARGETS: 'all', OPENCODE_VERSION: 'wrong'}, updateInstalled, ...options});
    return {root, bridge, runtime, calls, state, buildId, index, execute};
}

test('install builds current sources, packages only the host, then publishes a verified generation and updates installed bridge', async t => {
    const f = await fixture(t), output = [];
    const result = await f.execute({output: {info: (...args) => output.push(['info', ...args]), success: text => output.push(['success', text])}});
    assert.deepEqual(f.calls.map(call => call.script), ['build.mjs', 'prepare-opencode.mjs', 'package-bridge-runtime.mjs']);
    assert.equal(f.calls[1].env.OPENCODE_TARGETS, `${process.platform}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}${devBridgeTarget().endsWith('-musl') ? '-musl' : ''}`);
    assert.equal(f.calls[1].env.OPENCODE_VERSION, undefined);
    assert.equal(result.installed.updated, true); assert.equal(f.state.updates, 1);
    const pointer = JSON.parse(await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'));
    assert.deepEqual(pointer, {version: '0.9.18', target: devBridgeTarget(), buildId: f.buildId, sourceCommit: '1'.repeat(40), directory: path.basename(path.dirname(f.state.updateOptions.archive))});
    assert.match(pointer.directory, /^generation-[\w-]+$/);
    assert.equal(await fs.readFile(f.state.updateOptions.archive, 'utf8'), 'fresh production dependencies and bundled Node');
    assert.deepEqual(output.map(event => event[0]), ['info', 'success']);
    assert.match(output[1][1], new RegExp(`0\\.9\\.18.*${f.buildId.slice(0, 12)}`));
    await assert.rejects(fs.access(path.join(f.root, '.run/dev-bridge/install.lock')), {code: 'ENOENT'});
});

for (const fail of ['build.mjs', 'prepare-opencode.mjs', 'package-bridge-runtime.mjs', 'checksum']) {
    test(`${fail} failure preserves the previous dev supply and never touches installed bridge`, async t => {
        const f = await fixture(t); await f.execute(); f.state.updates = 0;
        const previous = await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8');
        const files = await fs.readdir(f.runtime);
        if (fail === 'checksum') f.state.corrupt = true; else f.state.fail = fail;
        await assert.rejects(f.execute());
        assert.equal(await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'), previous);
        assert.deepEqual(await fs.readdir(f.runtime), files); assert.equal(f.state.updates, 0);
        await assert.rejects(fs.access(path.join(f.root, '.run/dev-bridge/install.lock')), {code: 'ENOENT'});
    });
}

test('an installed bridge failure is visible; verified supply remains usable and lock is released', async t => {
    const f = await fixture(t); f.state.fail = 'update';
    await assert.rejects(f.execute(), /offline paired bridge/);
    const current = JSON.parse(await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'));
    await fs.access(path.join(f.runtime, current.directory));
    await assert.rejects(fs.access(path.join(f.root, '.run/dev-bridge/install.lock')), {code: 'ENOENT'});
});

test('a pre-existing pointer staging file is never deleted or overwritten after exclusive creation refuses it', async t => {
    const f = await fixture(t); await fs.mkdir(f.runtime, {recursive: true});
    const sentinel = path.join(f.runtime, `.current-${process.pid}.json`);
    await fs.writeFile(sentinel, 'other owner');
    await assert.rejects(f.execute(), {code: 'EEXIST'});
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'other owner');
    assert.deepEqual(await fs.readdir(f.runtime), [path.basename(sentinel)]);
    assert.equal(f.state.updates, 0);
});

test('failed pointer publication preserves an occupied destination and removes only its unpublished generation', async t => {
    const f = await fixture(t), current = path.join(f.runtime, 'current.json');
    await fs.mkdir(current, {recursive: true}); await fs.writeFile(path.join(current, 'sentinel'), 'existing data');
    await assert.rejects(f.execute());
    assert.equal(await fs.readFile(path.join(current, 'sentinel'), 'utf8'), 'existing data');
    assert.deepEqual(await fs.readdir(f.runtime), ['current.json']); assert.equal(f.state.updates, 0);
});

test('an unavailable checkout revision does not replace a previously verified dev supply', async t => {
    const f = await fixture(t); await f.execute(); f.state.updates = 0;
    const previous = await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8');
    await fs.rm(path.join(f.root, '.git'), {recursive: true});
    await assert.rejects(f.execute(), /определить ревизию/);
    assert.equal(await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'), previous); assert.equal(f.state.updates, 0);
});

test('repeated install repackages production dependencies even with the same version and dist build ID', async t => {
    const f = await fixture(t); await f.execute();
    const previous = JSON.parse(await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'));
    await fs.writeFile(path.join(f.bridge, 'package-lock.json'), 'dependency-only checkout change');
    await f.execute();
    const current = JSON.parse(await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'));
    assert.equal(current.version, previous.version); assert.equal(current.buildId, previous.buildId);
    assert.notEqual(current.directory, previous.directory);
    assert.equal(f.calls.filter(call => call.script === 'package-bridge-runtime.mjs').length, 2);
    await fs.access(path.join(f.runtime, previous.directory));
});

test('parallel install is refused before build and does not remove the other owner lock', async t => {
    const f = await fixture(t), lock = path.join(f.root, '.run/dev-bridge/install.lock');
    await fs.mkdir(lock, {recursive: true}); await fs.writeFile(path.join(lock, 'owner.pid'), 'other owner');
    await assert.rejects(f.execute(), /уже выполняется/); assert.deepEqual(f.calls, []);
    assert.equal(await fs.readFile(path.join(lock, 'owner.pid'), 'utf8'), 'other owner');
});

test('a linked runtime directory is refused before build or publication outside the checkout', async t => {
    const f = await fixture(t), other = path.join(f.root, 'other-data');
    await fs.mkdir(other); await fs.mkdir(path.dirname(f.runtime), {recursive: true});
    await fs.symlink(other, f.runtime, 'dir');
    await assert.rejects(f.execute(), /без символических ссылок/);
    assert.deepEqual(f.calls, []); assert.deepEqual(await fs.readdir(other), []);
});

test('runtime platform selection keeps Linux libc variants separate and rejects unsupported hosts', () => {
    assert.equal(devBridgeTarget('linux', 'x64', true), 'linux-x64-musl');
    assert.equal(devBridgeTarget('darwin', 'arm64', false), 'darwin-arm64');
    assert.throws(() => devBridgeTarget('win32', 'x64', false), /macOS и Linux/);
    assert.throws(() => devBridgeTarget('linux', 'riscv64', false), /arm64\/x64/);
});

test('a real failing build child returns a visible error before any archive or installed runtime is changed', async t => {
    const f = await fixture(t); await fs.mkdir(path.join(f.bridge, 'scripts'));
    await fs.writeFile(path.join(f.bridge, 'scripts/build.mjs'), 'process.exit(17);\n');
    await assert.rejects(f.execute({run: undefined}), /build.mjs.*17/);
    assert.deepEqual(await fs.readdir(f.runtime), []); assert.equal(f.state.updates, 0);
});

test('a missing build runtime fails before publication and releases the install lock', async t => {
    const f = await fixture(t);
    await assert.rejects(f.execute({run: undefined, node: path.join(f.root, 'missing-node')}), {code: 'ENOENT'});
    assert.deepEqual(await fs.readdir(f.runtime), []); assert.equal(f.state.updates, 0);
    await assert.rejects(fs.access(path.join(f.root, '.run/dev-bridge/install.lock')), {code: 'ENOENT'});
});

test('failed candidate cleanup retains the primary checksum error and still releases the install lock', async t => {
    const f = await fixture(t); await f.execute(); f.state.corrupt = true; f.state.updates = 0;
    const previous = await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'), remove = fs.rm;
    const stub = mock.method(fs, 'rm', async (file, options) => {
        if (path.dirname(file) === f.runtime && path.basename(file).startsWith('generation-')) {
            throw Object.assign(new Error('candidate cleanup failed'), {code: 'EACCES'});
        }
        return remove(file, options);
    });
    try {
        await assert.rejects(f.execute(), error => {
            assert.match(error.message, /не прошёл проверку/);
            assert.match(error.message, /candidate cleanup failed/);
            return true;
        });
        await assert.rejects(fs.access(path.join(f.root, '.run/dev-bridge/install.lock')), {code: 'ENOENT'});
        assert.equal(await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'), previous);
        assert.equal(f.state.updates, 0);
    } finally { stub.mock.restore(); }
});

for (const method of ['writeFile', 'sync']) {
    test(`a pointer ${method} failure leaves the previous supply unchanged and removes partial staging files`, async t => {
        const f = await fixture(t); await f.execute(); f.state.updates = 0;
        const previous = await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'), files = await fs.readdir(f.runtime), open = fs.open;
        const stub = mock.method(fs, 'open', async (file, ...args) => {
            const handle = await open(file, ...args);
            if (file === path.join(f.runtime, `.current-${process.pid}.json`)) {
                const original = handle[method].bind(handle);
                handle[method] = async (...parameters) => {
                    if (method === 'writeFile') await original(...parameters);
                    throw Object.assign(new Error(`pointer ${method} failed`), {code: 'EIO'});
                };
            }
            return handle;
        });
        try {
            await assert.rejects(f.execute(), {code: 'EIO'});
            assert.equal(await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'), previous);
            assert.deepEqual(await fs.readdir(f.runtime), files); assert.equal(f.state.updates, 0);
            await assert.rejects(fs.access(path.join(f.root, '.run/dev-bridge/install.lock')), {code: 'ENOENT'});
        } finally { stub.mock.restore(); }
    });
}

test('a cleanup failure after success remains visible while the published generation is kept and the lock released', async t => {
    const f = await fixture(t), remove = fs.rm;
    const stub = mock.method(fs, 'rm', async (file, options) => {
        if (file === path.join(f.runtime, `.current-${process.pid}.json`)) throw new Error('pointer cleanup failed');
        return remove(file, options);
    });
    try {
        await assert.rejects(f.execute(), /Не удалось очистить.*pointer cleanup failed/);
        const current = JSON.parse(await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'));
        await fs.access(path.join(f.runtime, current.directory)); assert.equal(f.state.updates, 1);
        await assert.rejects(fs.access(path.join(f.root, '.run/dev-bridge/install.lock')), {code: 'ENOENT'});
    } finally { stub.mock.restore(); }
});

test('default build subprocesses receive the host-only environment and verified archive destination', async t => {
    const f = await fixture(t), events = path.join(f.root, 'child-events.jsonl');
    await fs.mkdir(path.join(f.bridge, 'scripts')); await fs.mkdir(path.join(f.root, 'scripts'));
    const trace = `import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
        await fs.appendFile(${JSON.stringify(events)},JSON.stringify({script:path.basename(process.argv[1]),node:process.versions.node,cwd:process.cwd(),targets:process.env.OPENCODE_TARGETS,output:process.env.BRIDGE_RUNTIME_OUTPUT_DIR})+'\\n');\n`;
    await fs.writeFile(path.join(f.bridge, 'scripts/build.mjs'), trace + `await fs.writeFile(${JSON.stringify(path.join(f.bridge, 'dist/index.js'))},${JSON.stringify(f.index)});
        await fs.writeFile(${JSON.stringify(path.join(f.bridge, 'dist/build.json'))},JSON.stringify({version:'0.9.18',buildId:${JSON.stringify(f.buildId)}}));`);
    await fs.writeFile(path.join(f.root, 'scripts/prepare-opencode.mjs'), trace);
    await fs.writeFile(path.join(f.root, 'scripts/package-bridge-runtime.mjs'), trace + `
        const bytes=Buffer.from('real child archive fixture'),sha256=createHash('sha256').update(bytes).digest('hex');
        const file=path.join(process.env.BRIDGE_RUNTIME_OUTPUT_DIR,${JSON.stringify(`neurocenter-asset-sync-${devBridgeTarget()}-0.9.18.tgz`)});
        await fs.writeFile(file,bytes);await fs.writeFile(file+'.sha256',sha256+'\\n');
        await fs.writeFile(file+'.json',JSON.stringify({version:'0.9.18',target:${JSON.stringify(devBridgeTarget())},buildId:${JSON.stringify(f.buildId)},nodeVersion:process.versions.node,probeEngine:{version:${JSON.stringify(opencodeVersion)}},bytes:bytes.length,sha256}));`);
    await f.execute({run: undefined, environment: {PATH: process.env.PATH}});
    const calls = (await fs.readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(call => call.script), ['build.mjs', 'prepare-opencode.mjs', 'package-bridge-runtime.mjs']);
    assert.ok(calls.every(call => call.cwd === f.root && call.node === process.versions.node));
    assert.equal(calls[1].targets, `${process.platform}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}${devBridgeTarget().endsWith('-musl') ? '-musl' : ''}`);
    assert.equal(path.dirname(calls[2].output), f.runtime); assert.equal(f.state.updates, 1);
});

test('lock access denial aborts before build and preserves the previous source generation', async t => {
    const f = await fixture(t); await f.execute(); f.state.updates = 0; f.calls.length = 0;
    const previous = await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'), mkdir = fs.mkdir;
    const stub = mock.method(fs, 'mkdir', async (file, options) => {
        if (file === path.join(f.root, '.run/dev-bridge/install.lock')) throw Object.assign(new Error('lock access denied'), {code: 'EACCES'});
        return mkdir(file, options);
    });
    try {
        await assert.rejects(f.execute(), {code: 'EACCES'});
        assert.deepEqual(f.calls, []); assert.equal(f.state.updates, 0);
        assert.equal(await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'), previous);
    } finally { stub.mock.restore(); }
});

test('default install defers migration without creating a profile or pairing in an isolated home', async t => {
    const f = await fixture(t), home = path.join(f.root, 'uninstalled-home');
    await fs.mkdir(home);
    const result = await f.execute({updateInstalled: undefined, environment: {HOME: home, PATH: process.env.PATH}});
    assert.equal(result.installed.updated, false); assert.equal(result.installed.reason, 'server-start-pending');
    assert.deepEqual(await fs.readdir(home), []);
    const current = JSON.parse(await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'));
    await fs.access(path.join(f.runtime, current.directory));
});

test('a build child terminated by a signal reports that signal and leaves no candidate or install lock', async t => {
    const f = await fixture(t); await fs.mkdir(path.join(f.bridge, 'scripts'));
    await fs.writeFile(path.join(f.bridge, 'scripts/build.mjs'), 'process.kill(process.pid, "SIGTERM");\n');
    await assert.rejects(f.execute({run: undefined}), error => {
        assert.match(error.message, /сигналом SIGTERM/); assert.doesNotMatch(error.message, /кодом null/); return true;
    });
    assert.deepEqual(await fs.readdir(f.runtime), []); assert.equal(f.state.updates, 0);
    await assert.rejects(fs.access(path.join(f.root, '.run/dev-bridge/install.lock')), {code: 'ENOENT'});
});
