import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const realNode = await fs.realpath(process.execPath);
const posix = process.platform !== 'win32';
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const nativeMachine = posix ? spawnSync('/usr/bin/uname', ['-m'], {encoding: 'utf8'}).stdout.trim() : '';
const nativeArch = /^(arm64|aarch64)$/.test(nativeMachine) ? 'arm64' : 'x64';
const nativePlatform = process.platform;
const nodeTest = (name, run) => test(name, {skip: !posix}, run);

/** Only a copied shell entrypoint runs; the ESM target cannot reach the app or network. */
async function fixture(t) {
    assert.match(process.versions.node, /^24\./, 'Run bootstrap acceptance itself with the real Node 24.');
    const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter bootstrap ')));
    t.after(() => fs.rm(temporary, {recursive: true, force: true}));
    const checkout = path.join(temporary, 'checkout with spaces'), caller = path.join(temporary, 'caller with spaces');
    const utilities = path.join(temporary, 'isolated utilities'), record = path.join(temporary, 'runtime.json');
    const probes = path.join(temporary, 'probes.log'), traps = path.join(temporary, 'rejected-modern.log');
    const services = path.join(temporary, 'forbidden-commands.log');
    await Promise.all([fs.mkdir(path.join(checkout, 'scripts'), {recursive: true}), fs.mkdir(caller), fs.mkdir(utilities)]);
    await fs.copyFile(path.join(repository, 'scripts/dev.sh'), path.join(checkout, 'scripts/dev.sh'));
    await fs.chmod(path.join(checkout, 'scripts/dev.sh'), 0o700);
    // Never expose a machine's node/npm through the fixture PATH, including /usr/bin/node on Linux.
    for (const command of ['dirname', 'basename', 'uname', 'sort', 'head', 'tail', 'sed', 'awk', 'tr', 'cut', 'readlink', 'realpath', 'find', 'ls', 'stat']) {
        for (const directory of ['/usr/bin', '/bin']) {
            const source = path.join(directory, command);
            if (await fs.access(source, fs.constants.X_OK).then(() => true, () => false)) {
                await fs.symlink(source, path.join(utilities, command));
                break;
            }
        }
    }
    for (const command of ['npm', 'npx', 'docker', 'curl', 'wget', 'git']) {
        await fs.writeFile(path.join(utilities, command), `#!/bin/bash\nprintf '%s\\n' ${shellQuote(command)} >> "$DEV_BOOTSTRAP_SERVICES"\nexit 94\n`, {mode: 0o700});
    }
    await fs.writeFile(path.join(checkout, 'scripts/dev.mjs'), `import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const child=spawnSync('node',['-p','process.versions.node'],{encoding:'utf8',timeout:2000});
fs.writeFileSync(process.env.DEV_BOOTSTRAP_RECORD,JSON.stringify({runtime:process.versions.node,execPath:process.execPath,
 argv:process.argv.slice(2),cwd:process.cwd(),nodeBin:process.env.NODE_BIN??null,path:process.env.PATH,
 selected:process.env.DEV_BOOTSTRAP_EXECUTED,childStatus:child.status,childVersion:child.stdout?.trim()}));
`);
    async function candidate(filename, version, {allowModern = /^24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), executable = true, probeExit = 0} = {}) {
        await fs.mkdir(path.dirname(filename), {recursive: true});
        const launch = allowModern
            ? `export DEV_BOOTSTRAP_EXECUTED="$0"\nexec ${shellQuote(realNode)} "$@"`
            : 'printf \'%s\\n\' "$0" >> "$DEV_BOOTSTRAP_TRAPS"\nprintf \'REJECTED_NODE_ATTEMPTED_MODERN_DEV\\n\' >&2\nexit 97';
        await fs.writeFile(filename, `#!/bin/bash
if [[ "$#" == 2 && "$1" == -p && "$2" == process.versions.node ]]; then
 printf '%s\\n' "$0" >> "$DEV_BOOTSTRAP_PROBES"
 printf '%s\\n' ${shellQuote(version)}
 exit ${probeExit}
fi
${launch}
`, {mode: executable ? 0o700 : 0o600});
        return filename;
    }
    async function toolchain(version, {platform = nativePlatform, arch = nativeArch, missing, reported = version, executable = true, destination} = {}) {
        const directory = destination ?? path.join(checkout, '.run/toolchains', `node-v${version}-${platform}-${arch}`);
        const binary = path.join(directory, 'bin/node');
        await candidate(binary, reported, {executable});
        if (missing !== 'license') await fs.writeFile(path.join(directory, 'LICENSE'), 'isolated official-distribution license marker');
        if (missing !== 'npm') {
            await fs.mkdir(path.join(directory, 'lib/node_modules/npm/bin'), {recursive: true});
            await fs.writeFile(path.join(directory, 'lib/node_modules/npm/bin/npm-cli.js'), 'isolated npm marker');
        }
        return binary;
    }
    async function lines(filename) {
        return fs.readFile(filename, 'utf8').then(value => value.trim().split('\n').filter(Boolean), error => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
    }
    async function run({nodeBin, nvmDir, paths = [], args = ['--help'], direct = false, emptyPath = false} = {}) {
        const entrypoint = path.join(checkout, 'scripts/dev.sh');
        const result = spawnSync(direct ? entrypoint : '/bin/bash', direct ? args : [entrypoint, ...args], {
            cwd: caller, encoding: 'utf8', timeout: 5000,
            // HOME, NODE_OPTIONS and user credentials are intentionally not inherited or reassigned.
            env: {PATH: emptyPath ? '' : [...paths, utilities].join(path.delimiter), NO_COLOR: '1', TERM: 'dumb',
                DEV_BOOTSTRAP_RECORD: record, DEV_BOOTSTRAP_PROBES: probes, DEV_BOOTSTRAP_TRAPS: traps,
                DEV_BOOTSTRAP_SERVICES: services, ...(nodeBin === undefined ? {} : {NODE_BIN: nodeBin}),
                ...(nvmDir === undefined ? {} : {NVM_DIR: nvmDir})},
        });
        assert.equal(result.error, undefined, result.error?.message);
        const rejected = await lines(traps), forbidden = await lines(services);
        assert.deepEqual(rejected, [], 'A rejected runtime executed the modern dev target.');
        assert.deepEqual(forbidden, [], 'Bootstrap attempted a service, download or package operation.');
        const saved = await fs.readFile(record, 'utf8').then(JSON.parse, error => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
        });
        await assert.rejects(fs.access(path.join(checkout, '.run/processes.json')), {code: 'ENOENT'});
        return {...result, saved, probes: await lines(probes)};
    }
    return {temporary, checkout, caller, utilities, candidate, toolchain, run};
}

function assertBooted(f, result, binary, version, args = ['--help']) {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.saved, 'The isolated ESM target was not launched.');
    assert.match(result.saved.runtime, /^24\./);
    assert.equal(result.saved.execPath, realNode);
    assert.equal(result.saved.nodeBin, binary);
    assert.equal(result.saved.selected, binary);
    assert.equal(result.saved.cwd, f.checkout);
    assert.deepEqual(result.saved.argv, args);
    assert.equal(result.saved.path.split(path.delimiter)[0], path.dirname(binary));
    assert.equal(result.saved.childStatus, 0);
    assert.equal(result.saved.childVersion, version, 'A plain child node bypassed the chosen Node 24.');
}

for (const version of ['20.19.5', '16.20.2']) {
    nodeTest(`Bootstrap skips PATH Node ${version} before modern ESM and uses the complete project Node 24`, async t => {
        const f = await fixture(t), old = await f.candidate(path.join(f.temporary, 'old path/node'), version);
        const selected = await f.toolchain('24.22.0');
        assertBooted(f, await f.run({paths: [path.dirname(old)]}), selected, '24.22.0');
    });
}

for (const version of ['20.19.5', '25.1.0']) {
    nodeTest(`Invalid explicit NODE_BIN ${version} falls back to project Node 24 before parsing dev.mjs`, async t => {
        const f = await fixture(t), old = await f.candidate(path.join(f.temporary, 'explicit node/node'), version);
        const selected = await f.toolchain('24.22.0');
        assertBooted(f, await f.run({nodeBin: old}), selected, '24.22.0');
    });
}

for (const kind of ['missing', 'not executable', 'directory', 'no PATH node']) {
    nodeTest(`Bootstrap recovers from ${kind} with a complete project runtime`, async t => {
        const f = await fixture(t), selected = await f.toolchain('24.22.0');
        let binary = path.join(f.temporary, 'invalid runtime/node');
        if (kind === 'not executable') await f.candidate(binary, '24.22.0', {executable: false});
        if (kind === 'directory') await fs.mkdir(binary, {recursive: true});
        if (kind === 'no PATH node') binary = undefined;
        assertBooted(f, await f.run({nodeBin: binary}), selected, '24.22.0');
    });
}

for (const version of ['not-node', '', 'v24.22.0', '24.22.0 extra', '24.22.0\n25.1.0', '024.22.0', '240.1.0', '24.022.0', '24.22.00']) {
    nodeTest(`Malformed candidate version ${JSON.stringify(version)} cannot execute the modern target`, async t => {
        const f = await fixture(t), bad = await f.candidate(path.join(f.temporary, 'not a node/node'), version);
        const selected = await f.toolchain('24.22.0');
        assertBooted(f, await f.run({nodeBin: bad}), selected, '24.22.0');
    });
}

nodeTest('A non-node executable that rejects the version probe is skipped safely', async t => {
    const f = await fixture(t), bad = await f.candidate(path.join(f.temporary, 'other executable/node'), '', {probeExit: 64});
    const selected = await f.toolchain('24.22.0');
    assertBooted(f, await f.run({nodeBin: bad}), selected, '24.22.0');
});

nodeTest('Only native, executable, complete toolchains compete; minor and patch ordering is numeric', async t => {
    const f = await fixture(t);
    for (const version of ['24.9.0', '24.22.0', '24.22.9']) await f.toolchain(version);
    const selected = await f.toolchain('24.22.10');
    const skipped = [await f.toolchain('24.100.0', {missing: 'license'}), await f.toolchain('24.99.0', {missing: 'npm'}),
        await f.toolchain('24.98.0', {platform: nativePlatform === 'darwin' ? 'linux' : 'darwin'}),
        await f.toolchain('24.97.0', {arch: nativeArch === 'arm64' ? 'x64' : 'arm64'}),
        await f.toolchain('24.96.0', {executable: false}), await f.toolchain('25.10.0')];
    await f.toolchain('24.95.0', {reported: '25.1.0'});
    const result = await f.run();
    assertBooted(f, result, selected, '24.22.10');
    for (const binary of skipped) assert.ok(!result.probes.includes(binary), 'A wrong-platform or incomplete runtime was probed: ' + binary);
});

nodeTest('A valid explicit Node 24 keeps priority and propagates NODE_BIN and the plain-child PATH', async t => {
    const f = await fixture(t), explicit = await f.candidate(path.join(f.temporary, 'explicit valid/node'), '24.9.0');
    const fromPath = await f.candidate(path.join(f.temporary, 'path valid/node'), '24.21.0');
    await f.toolchain('24.22.0');
    assertBooted(f, await f.run({nodeBin: explicit, paths: [path.dirname(fromPath)]}), explicit, '24.9.0');
});

nodeTest('A valid PATH Node 24 keeps priority over project fallback', async t => {
    const f = await fixture(t), selected = await f.candidate(path.join(f.temporary, 'path valid/node'), '24.9.0');
    await f.toolchain('24.22.0');
    assertBooted(f, await f.run({paths: [path.dirname(selected)]}), selected, '24.9.0');
});

nodeTest('The whole PATH is searched after an obsolete first node', async t => {
    const f = await fixture(t), old = await f.candidate(path.join(f.temporary, 'first old/node'), '20.19.5');
    const selected = await f.candidate(path.join(f.temporary, 'second valid/node'), '24.15.0');
    assertBooted(f, await f.run({paths: [path.dirname(old), path.dirname(selected)]}), selected, '24.15.0');
});

nodeTest('Invalid explicit Node 25 falls back to valid PATH Node 24 before the project toolchain', async t => {
    const f = await fixture(t), bad = await f.candidate(path.join(f.temporary, 'explicit 25/node'), '25.1.0');
    const selected = await f.candidate(path.join(f.temporary, 'path valid/node'), '24.15.0');
    await f.toolchain('24.22.0');
    assertBooted(f, await f.run({nodeBin: bad, paths: [path.dirname(selected)]}), selected, '24.15.0');
});

nodeTest('A complete NVM Node 24 is discovered when the project has no valid runtime', async t => {
    const f = await fixture(t), nvmDir = path.join(f.temporary, 'NVM with spaces');
    const selected = await f.toolchain('24.15.0', {destination: path.join(nvmDir, 'versions/node/v24.15.0')});
    await f.toolchain('24.99.0', {missing: 'npm'});
    assertBooted(f, await f.run({nvmDir}), selected, '24.15.0');
});

nodeTest('The complete project Node 24 takes priority over a newer NVM fallback', async t => {
    const f = await fixture(t), nvmDir = path.join(f.temporary, 'NVM with spaces');
    const selected = await f.toolchain('24.22.0');
    await f.toolchain('24.99.0', {destination: path.join(nvmDir, 'versions/node/v24.99.0')});
    assertBooted(f, await f.run({nvmDir}), selected, '24.22.0');
});

nodeTest('Relative NODE_BIN is resolved in the caller directory with spaces before changing cwd', async t => {
    const f = await fixture(t), selected = await f.candidate(path.join(f.caller, 'relative runtime/node'), '24.22.0');
    const old = await f.candidate(path.join(f.temporary, 'old path/node'), '16.20.2');
    const args = ['--help', '--label', 'a value with spaces', '日本語'];
    assertBooted(f, await f.run({nodeBin: './relative runtime/node', paths: [path.dirname(old)], args}), selected, '24.22.0', args);
});

nodeTest('Relative PATH entries retain their caller-directory meaning after bootstrap changes cwd', async t => {
    const f = await fixture(t), selected = await f.candidate(path.join(f.caller, 'relative path/node'), '24.22.0');
    assertBooted(f, await f.run({paths: ['relative path']}), selected, '24.22.0');
});

nodeTest('Direct executable bootstrap with empty PATH uses the explicit Node 24', async t => {
    const f = await fixture(t), selected = await f.candidate(path.join(f.temporary, 'explicit valid/node'), '24.22.0');
    assertBooted(f, await f.run({nodeBin: selected, direct: true, emptyPath: true}), selected, '24.22.0');
});

nodeTest('Direct executable bootstrap with empty PATH discovers the complete project Node 24', async t => {
    const f = await fixture(t), selected = await f.toolchain('24.22.0');
    assertBooted(f, await f.run({direct: true, emptyPath: true}), selected, '24.22.0');
});

nodeTest('No valid runtime produces a friendly nonzero result without modern syntax errors or service calls', async t => {
    const f = await fixture(t), old = await f.candidate(path.join(f.temporary, 'old path/node'), '20.19.5');
    const explicit = await f.candidate(path.join(f.temporary, 'explicit 25/node'), '25.1.0');
    await f.toolchain('24.99.0', {missing: 'npm'});
    const result = await f.run({nodeBin: explicit, paths: [path.dirname(old)]});
    assert.notEqual(result.status, 0);
    assert.equal(result.saved, undefined);
    assert.match(result.stderr, /Node(?:\.js)?[^\n]*24|24[^\n]*Node/i);
    assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|Unexpected token|Cannot use import|ERR_MODULE|node:internal/);
});
