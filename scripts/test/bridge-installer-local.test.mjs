import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { installerLifecycleFixture } from './bridge-installer-lifecycle.fixture.mjs';

const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const events = f => fs.readFile(f.environment.INSTALLER_FIXTURE_EVENTS, 'utf8').then(text => text.trim().split('\n'), error => { if (error.code === 'ENOENT') return []; throw error; });
async function artifact(f) {
    const archive = path.join(f.root, "local archive ' $().tgz");
    await fs.copyFile(path.join(f.root, 'bridge.tgz'), archive);
    await fs.writeFile(archive + '.sha256', sha(await fs.readFile(archive)) + '\n');
    return archive;
}
async function run(f, args, overrides = {}) {
    try { return { status: 0, ...await exec('/bin/bash', [path.join(f.root, 'install.sh'), ...args], {
        env: { ...f.environment, ...overrides }, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    }) }; } catch (error) { if (typeof error.code !== 'number') throw error; return { status: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
async function profile(f, api = f.origin, worker = false) {
    const environment = { NEUROCENTER_URL: f.origin, NEUROCENTER_API_URL: api, HOME: path.join(f.root, 'saved home'),
        NEUROCENTER_BRIDGE_HOME: path.join(f.root, 'saved bridge'), CUSTOM_SETTING: 'retain me' };
    const own = { type: 'local', enabled: false, command: [path.join(f.install, 'bin/node'), path.join(f.install, 'dist/index.js')], timeout: 45000, environment };
    const text = '// Keep comments and all own/foreign settings\n' + JSON.stringify({ agent: { mine: { mode: 'subagent' } },
        mcp: { other: { type: 'remote', url: 'https://other.example.test' }, 'neurocenter-asset-sync': own } }, null, 2) + '\n';
    const config = path.join(f.environment.XDG_CONFIG_HOME, 'opencode/opencode.jsonc');
    await fs.mkdir(path.dirname(config), { recursive: true }); await fs.writeFile(config, text, { mode: 0o640 });
    const credentials = path.join(environment.NEUROCENTER_BRIDGE_HOME, sha(f.origin).slice(0, 20), 'credentials.json');
    const bytes = Buffer.from(JSON.stringify({ token: 'owned-worker-token', deviceId: 'owned' }));
    await fs.mkdir(path.dirname(credentials), { recursive: true }); await fs.writeFile(credentials, bytes, { mode: 0o600 }); f.state.token = 'owned-worker-token';
    const started = worker ? await f.startWorker(environment) : undefined;
    return { config, text, credentials, bytes, started };
}
async function preserved(saved) {
    assert.equal(await fs.readFile(saved.config, 'utf8'), saved.text);
    assert.equal((await fs.stat(saved.config)).mode & 0o777, 0o640);
    assert.deepEqual(await fs.readFile(saved.credentials), saved.bytes);
}
async function unchangedOld(f) { assert.equal(await fs.readFile(path.join(f.install, 'previous.txt'), 'utf8'), 'owned old runtime'); }

test('Local archive installs with implicit sidecar and no curl, system Node/npm, HTTP, pairing or connection', () => installerLifecycleFixture('local-fresh', async f => {
    await fs.rm(f.install, { recursive: true }); const archive = await artifact(f), tools = path.join(f.root, 'offline tools'); await fs.mkdir(tools);
    const digest = spawnSync('/usr/bin/which', ['sha256sum'], { encoding: 'utf8' }).status === 0 ? 'sha256sum' : 'shasum';
    for (const name of ['uname', 'tar', 'gzip', 'grep', 'awk', digest, 'dirname', 'basename', 'mkdir', 'rmdir', 'mktemp', 'mv', 'rm', 'cat', ...(process.platform === 'darwin' ? ['sysctl'] : [])]) {
        const file = execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim(); await fs.symlink(file, path.join(tools, name));
    }
    for (const name of ['curl', 'node', 'npm']) assert.notEqual(spawnSync('/bin/sh', ['-c', 'command -v ' + name], { env: { ...f.environment, PATH: tools } }).status, 0);
    const result = await run(f, ['--archive', archive], { PATH: tools }); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.install, 'package.json'), 'utf8')).version, f.version);
    assert.deepEqual(await events(f), ['--init']); assert.equal(f.state.requests.length, 0);
    assert.equal(await fs.readFile(path.join(f.home, '.local/bin/neurocenter-bridge'), 'utf8'), 'owned caller launcher');
    assert.match(result.stdout, /локального архива/); assert.match(result.stdout, /подключ/i); assert.doesNotMatch(result.stdout, /установлен и подключ[её]н|Компьютер уже подключ[её]н/);
}));

test('Local archive accepts a separate explicit SHA file with spaces', () => installerLifecycleFixture('local-explicit-sha', async f => {
    await fs.rm(f.install, { recursive: true }); const archive = await artifact(f), digest = path.join(f.root, 'explicit digest.sha256');
    await fs.rename(archive + '.sha256', digest); const result = await run(f, ['--sha256-file', digest, '--archive', archive]);
    assert.equal(result.status, 0, result.stderr); assert.equal(f.state.requests.length, 0); assert.deepEqual(await events(f), ['--init']);
}));

test('Repeated local update keeps disabled JSONC, custom runtime HOME, credentials and other agents byte-for-byte', () => installerLifecycleFixture('local-repeat-profile', async f => {
    const archive = await artifact(f), saved = await profile(f);
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await run(f, ['--archive', archive], { INSTALLER_FIXTURE_NATIVE_UPGRADE: '1', INSTALLER_FIXTURE_REQUIRE_PROFILE: '1' });
        assert.equal(result.status, 0, result.stderr); await preserved(saved); assert.equal(f.state.paused, false);
    }
    assert.deepEqual(await events(f), ['--prepare-upgrade', '--finish-upgrade', '--prepare-upgrade', '--finish-upgrade']);
    assert.deepEqual(f.state.requests.map(row => [row.method, row.route]), Array.from({ length: 2 }, () => [
        ['POST', '/api/device-channel/worker/pause'], ['POST', '/api/device-channel/worker/resume'],
    ]).flat());
    const contexts = (await fs.readFile(f.environment.INSTALLER_FIXTURE_CONTEXTS, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(contexts.filter(row => row.mode === '--prepare-upgrade').every(row => row.home === path.join(f.root, 'saved home')));
    assert.ok(contexts.filter(row => row.mode === '--install-command').every(row => row.home === f.home));
}));

test('Wrong local SHA preserves the previous runtime, profile and keys before any CLI or HTTP', () => installerLifecycleFixture('local-bad-sha', async f => {
    const archive = await artifact(f), saved = await profile(f); await fs.writeFile(archive + '.sha256', '0'.repeat(64) + '\n');
    const result = await run(f, ['--archive', archive]); assert.notEqual(result.status, 0); await unchangedOld(f); await preserved(saved);
    assert.deepEqual(await events(f), []); assert.equal(f.state.requests.length, 0); assert.match(result.stderr, /сумма/);
}));

test('A SHA-valid archive for the wrong target is rejected before changing the old runtime/profile', () => installerLifecycleFixture('local-wrong-target', async f => {
    const saved = await profile(f), archive = await artifact(f), metadata = path.join(f.root, 'package/runtime.json');
    const value = JSON.parse(await fs.readFile(metadata, 'utf8')); await fs.writeFile(metadata, JSON.stringify({ ...value, target: 'windows-arm64' }));
    await exec('tar', ['-czf', archive, '-C', path.join(f.root, 'package'), 'bin', 'dist', 'package.json', 'runtime.json', 'node_modules']);
    await fs.writeFile(archive + '.sha256', sha(await fs.readFile(archive)) + '\n'); const result = await run(f, ['--archive', archive]);
    assert.notEqual(result.status, 0); await unchangedOld(f); await preserved(saved); assert.deepEqual(await events(f), []); assert.equal(f.state.requests.length, 0);
    assert.match(result.stderr, /отпечаток пакета/);
}));

test('A refused saved API cannot be bypassed by local delivery while an owned old worker is running', () => installerLifecycleFixture('local-offline-worker', async f => {
    const endpoint = net.createServer(); await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
    const refused = 'http://127.0.0.1:' + endpoint.address().port; await new Promise(resolve => endpoint.close(resolve));
    const archive = await artifact(f), saved = await profile(f, refused, true);
    const result = await run(f, ['--archive', archive], { INSTALLER_FIXTURE_NATIVE_UPGRADE: '1', INSTALLER_FIXTURE_REQUIRE_PROFILE: '1' });
    assert.notEqual(result.status, 0); await unchangedOld(f); await preserved(saved); process.kill(saved.started.pid, 0);
    assert.equal(f.state.requests.length, 0); assert.deepEqual(await events(f), ['--worker', '--prepare-upgrade', '--finish-upgrade']);
    assert.match(result.stderr, /Обновление не выполнено/); assert.doesNotMatch(result.stdout + result.stderr, /owned-worker-token/);
}));

for (const row of [
    { name: 'missing archive value', args: ['--archive'] }, { name: 'empty archive value', args: ['--archive', ''] },
    { name: 'orphan SHA option', args: ['--sha256-file', 'unused.sha256'] }, { name: 'unknown option', args: ['--unknown'] },
    { name: 'duplicate archive option', args: ['--archive', 'one', '--archive', 'two'] },
    { name: 'missing SHA value', args: ['--archive', 'one', '--sha256-file'] },
]) test('Installer rejects ' + row.name + ' before locks, CLI or network', () => installerLifecycleFixture('local-args-' + row.name, async f => {
    const result = await run(f, row.args); assert.notEqual(result.status, 0); await unchangedOld(f);
    assert.deepEqual(await events(f), []); assert.equal(f.state.requests.length, 0); await assert.rejects(fs.stat(f.install + '.install-lock'), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(path.dirname(f.install))).filter(name => name.startsWith('.neurocenter-install.')), []);
}));

test('Installer help documents the short local command without invoking installation', () => installerLifecycleFixture('local-help', async f => {
    const result = await run(f, ['--help']); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /--archive/); assert.match(result.stdout, /--sha256-file/);
    await unchangedOld(f); assert.equal(f.state.requests.length, 0); assert.deepEqual(await events(f), []);
}));

test('PowerShell local transport has bound parameters, literal copies and an explicit stop before connect (source contract only)', async () => {
    const source = await fs.readFile(process.env.BRIDGE_LOCAL_TEST_POWERSHELL_TEMPLATE || new URL('../../bridge-dist/install.ps1', import.meta.url), 'utf8');
    assert.match(source, /\[CmdletBinding\(\)\]/); assert.match(source, /\[string\]\$Archive/); assert.match(source, /\[string\]\$Sha256File/);
    assert.match(source, /Copy-Item -LiteralPath \$Archive/); assert.match(source, /Copy-Item -LiteralPath \$Sha256File/);
    assert.match(source, /\$Archive \+ '\.sha256'/);
    assert.doesNotMatch(source, /\$script:/i); assert.match(source, /\$ContextState\.Prepared = \$true/);
    assert.doesNotMatch(source, /(?:Test-Path|Get-Content|Get-FileHash|Move-Item|Remove-Item|Set-Content)\s+\$/);
    assert.ok(source.indexOf('Set-Acl -LiteralPath $Stage') < source.indexOf('[IO.File]::WriteAllText($ContextHelper'));
    const finish = source.indexOf("Step 4 'Проверяем подключение");
    assert.ok(finish > 0); assert.match(source.slice(source.indexOf("'  Команда подключения готова"), finish), /if \(\$LocalMode\)[\s\S]*return/);
});
