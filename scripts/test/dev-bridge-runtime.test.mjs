import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
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
    return {root, bridge, runtime, calls, state, buildId, execute};
}

test('install builds current sources, packages only the host, then publishes a verified generation and updates installed bridge', async t => {
    const f = await fixture(t), result = await f.execute();
    assert.deepEqual(f.calls.map(call => call.script), ['build.mjs', 'prepare-opencode.mjs', 'package-bridge-runtime.mjs']);
    assert.equal(f.calls[1].env.OPENCODE_TARGETS, `${process.platform}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}${devBridgeTarget().endsWith('-musl') ? '-musl' : ''}`);
    assert.equal(f.calls[1].env.OPENCODE_VERSION, undefined);
    assert.equal(result.installed.updated, true); assert.equal(f.state.updates, 1);
    const pointer = JSON.parse(await fs.readFile(path.join(f.runtime, 'current.json'), 'utf8'));
    assert.deepEqual(pointer, {version: '0.9.18', target: devBridgeTarget(), buildId: f.buildId, sourceCommit: '1'.repeat(40), directory: path.basename(path.dirname(f.state.updateOptions.archive))});
    assert.match(pointer.directory, /^generation-[\w-]+$/);
    assert.equal(await fs.readFile(f.state.updateOptions.archive, 'utf8'), 'fresh production dependencies and bundled Node');
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
