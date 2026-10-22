import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readBridgeTemplate } from '../workspace/bridge-templates.mjs';
import { installerLifecycleFixture } from './bridge-installer-lifecycle.fixture.mjs';

const exec = promisify(execFile), hash = text => createHash('sha256').update(text).digest('hex');
/** Execute the exact injected CJS on this host; this does not execute PowerShell or assert native Windows behavior. */
async function context(f) {
    const template = await readBridgeTemplate(process.env.BRIDGE_LOCAL_TEST_POWERSHELL_TEMPLATE || new URL('../../bridge-dist/install.ps1', import.meta.url));
    const body = /\$ContextSource = @'\r?\n([\s\S]*?)\r?\n'@/.exec(template)?.[1];
    assert.ok(body, 'The installer must embed the shared context before changing an existing registration.');
    assert.equal(body, await fs.readFile(new URL('../../bridge-dist/context.cjs', import.meta.url), 'utf8'));
    const helper = path.join(f.root, 'ps-context.cjs'), receipt = path.join(f.root, 'ps-context.json'); await fs.writeFile(helper, body, { mode: 0o600 });
    return async (...args) => (await exec(process.execPath, ['-e', 'require(process.argv[1]).main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1})', helper, receipt, ...args],
        { env: { ...f.environment, INSTALLER_FIXTURE_NATIVE_UPGRADE: '1', INSTALLER_FIXTURE_REQUIRE_PROFILE: '1' }, encoding: 'utf8', timeout: 10000 })).stdout.trim();
}
async function savedProfile(f) {
    f.environment.XDG_CONFIG_HOME = path.join(f.home, 'config [owner]');
    const home = path.join(f.root, 'saved runtime home [owner]'), bridgeHome = path.join(f.root, 'saved state [owner]');
    const text = '// Keep exact own and foreign settings\n' + JSON.stringify({ agent: { other: { mode: 'subagent' } }, mcp: {
        'neurocenter-asset-sync': { type: 'local', enabled: false, command: [path.join(f.install, 'bin/node'), path.join(f.install, 'dist/index.js')],
            environment: { HOME: home, NEUROCENTER_BRIDGE_HOME: bridgeHome, NEUROCENTER_URL: f.origin, NEUROCENTER_API_URL: f.origin, CUSTOM_VALUE: 'keep' } },
    } }, null, 2) + '\n';
    const config = path.join(f.environment.XDG_CONFIG_HOME, 'opencode/opencode.jsonc'), credentials = path.join(bridgeHome, hash(f.origin).slice(0, 20), 'credentials.json');
    await fs.mkdir(path.dirname(config), { recursive: true }); await fs.writeFile(config, text, { mode: 0o640 });
    const bytes = Buffer.from(JSON.stringify({ token: 'owned-worker-token', deviceId: 'owned' }));
    await fs.mkdir(path.dirname(credentials), { recursive: true }); await fs.writeFile(credentials, bytes, { mode: 0o600 }); f.state.token = 'owned-worker-token';
    return { config, text, credentials, bytes, home, bridgeHome };
}

test('Shared context embedded in PowerShell keeps exact disabled registration and uses the saved runtime profile for pause/resume', () => installerLifecycleFixture('local-ps-old-owner', async f => {
    const saved = await savedProfile(f), call = await context(f), node = path.join(f.install, 'bin/node'), entry = path.join(f.install, 'dist/index.js');
    assert.equal(await call('capture', path.join(f.root, 'package'), f.install, f.origin, f.origin), '1');
    assert.equal(await call('needs-prepare'), '1'); await call('assert');
    assert.equal(JSON.parse(await call('run', node, entry, '--prepare-upgrade', entry)).ok, true);
    assert.equal(JSON.parse(await call('run', node, entry, '--finish-upgrade')).ok, true);
    assert.equal(await fs.readFile(saved.config, 'utf8'), saved.text); assert.equal((await fs.stat(saved.config)).mode & 0o777, 0o640);
    assert.deepEqual(await fs.readFile(saved.credentials), saved.bytes); assert.equal(f.state.paused, false);
    assert.deepEqual(f.state.requests.map(row => [row.route, row.authorization]), [['/api/device-channel/worker/pause', true], ['/api/device-channel/worker/resume', true]]);
    const contexts = (await fs.readFile(f.environment.INSTALLER_FIXTURE_CONTEXTS, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(contexts.every(row => row.home === saved.home && row.bridgeHome === saved.bridgeHome && row.site === f.origin && row.api === f.origin));
}));

test('Shared PowerShell context migrates only own origins, connects to the target without old credentials, and restores the exact snapshot', () => installerLifecycleFixture('local-ps-migrate-restore', async f => {
    const saved = await savedProfile(f), call = await context(f), issuer = await f.startIssuer();
    assert.equal(await call('capture', path.join(f.root, 'package'), f.install, issuer, issuer), '2');
    assert.equal(await call('needs-prepare'), '0'); await call('assert'); await call('migrate', path.join(f.root, 'package'));
    const expected = saved.text.replaceAll(JSON.stringify(f.origin), JSON.stringify(issuer)); assert.equal(await fs.readFile(saved.config, 'utf8'), expected);
    const result = JSON.parse(await call('connect', path.join(f.install, 'bin/node'), path.join(f.install, 'dist/index.js'), '--connect-open'));
    assert.equal(new URL(result.url).origin, issuer);
    assert.deepEqual(f.state.issuerRequests.map(row => [row.method, row.route, row.authorization]), [['POST', '/api/device-channel/pair/start', false]]);
    assert.equal(f.state.requests.length, 0); await call('restore', path.join(f.root, 'package'));
    assert.equal(await fs.readFile(saved.config, 'utf8'), saved.text); assert.deepEqual(await fs.readFile(saved.credentials), saved.bytes);
}));

test('Shared PowerShell context refuses rollback over a later user edit and leaves original keys intact', () => installerLifecycleFixture('local-ps-rollback-cas', async f => {
    const saved = await savedProfile(f), call = await context(f), issuer = await f.startIssuer();
    await call('capture', path.join(f.root, 'package'), f.install, issuer, issuer); await call('needs-prepare'); await call('migrate', path.join(f.root, 'package'));
    const edited = await fs.readFile(saved.config, 'utf8') + '// Later user edit\n'; await fs.writeFile(saved.config, edited);
    await assert.rejects(call('restore', path.join(f.root, 'package')), /изменилась/);
    assert.equal(await fs.readFile(saved.config, 'utf8'), edited); assert.deepEqual(await fs.readFile(saved.credentials), saved.bytes); assert.equal(f.state.requests.length, 0);
}));
