import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {nodeRuntime, npmCli} from '../workspace/node-runtime.mjs';
import {checkPlan, nodeTestFiles, workspacePackages} from '../workspace/check-plan.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('npm и обычный node-потомок используют выбранный runtime, обходя старый node из PATH', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter runtime '));
    try {
        if (process.platform !== 'win32') await fs.writeFile(path.join(temporary, 'node'), '#!/bin/sh\nexit 82\n', {mode: 0o700});
        const selected = nodeRuntime({...process.env, NODE_BIN: process.execPath, PATH: temporary + path.delimiter + process.env.PATH});
        assert.ok(Number(selected.version.split('.')[0]) >= 24);
        const command = process.platform === 'win32' ? 'node.exe' : 'node';
        const child = spawnSync(command, ['-p', 'process.versions.node'], {env: selected.env, encoding: 'utf8'});
        assert.equal(child.status, 0); assert.equal(child.stdout.trim(), selected.version);
        const npm = spawnSync(selected.node, [npmCli(selected.env), '--version'], {env: selected.env, encoding: 'utf8'});
        assert.equal(npm.status, 0); assert.match(npm.stdout.trim(), /^\d+\.\d+\.\d+$/);
    } finally { await fs.rm(temporary, {recursive: true, force: true}); }
});

test('Явно заданный неработающий NODE_BIN не подменяется другим runtime', () => {
    assert.throws(() => nodeRuntime({...process.env, NODE_BIN: path.join(os.tmpdir(), 'missing-neurocenter-node')}), /NODE_BIN/);
});

/** Настоящий каталог toolchains читается только внутри fixture; запуск кандидатов заменён ответами Node. */
async function projectRuntimeFixture(t, platform, arch) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter project runtime ')));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const checkout = path.join(directory, 'checkout'), toolchains = path.join(checkout, '.run/toolchains');
    await fs.mkdir(path.join(checkout, 'scripts/workspace'), {recursive: true});
    await fs.copyFile(path.join(root, 'scripts/workspace/node-runtime.mjs'), path.join(checkout, 'scripts/workspace/node-runtime.mjs'));
    const names = ['24.3.0', '24.21.1', '24.22.0', '24.99.0', '24.98.0', '25.1.0'].map(version => `node-v${version}-${platform}-${arch}`);
    names.push(`node-v24.97.0-${platform === 'darwin' ? 'linux' : 'darwin'}-${arch}`,
        `node-v24.96.0-${platform}-${arch === 'arm64' ? 'x64' : 'arm64'}`);
    for (const name of names) {
        const candidate = path.join(toolchains, name);
        await fs.mkdir(path.join(candidate, 'bin'), {recursive: true});
        await fs.writeFile(path.join(candidate, 'bin/node'), 'isolated binary marker');
        if (!name.startsWith('node-v24.99.0')) await fs.writeFile(path.join(candidate, 'LICENSE'), 'isolated license marker');
        if (!name.startsWith('node-v24.98.0')) {
            await fs.mkdir(path.join(candidate, 'lib/node_modules/npm/bin'), {recursive: true});
            await fs.writeFile(path.join(candidate, 'lib/node_modules/npm/bin/npm-cli.js'), 'isolated npm marker');
        }
    }
    const current = path.join(directory, 'current/node'), pathNode = path.join(directory, 'path/node');
    const hook = path.join(directory, 'runtime-candidates.mjs'), runner = path.join(directory, 'select.mjs');
    await fs.writeFile(hook, `
        import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
        const settings=JSON.parse(process.env.RUNTIME_FIXTURE_SETTINGS);globalThis.runtimeCalls=[];
        Object.defineProperty(process,'execPath',{value:settings.current});
        Object.defineProperty(process,'platform',{value:settings.platform});Object.defineProperty(process,'arch',{value:settings.arch});
        childProcess.spawnSync=(binary)=>{
            globalThis.runtimeCalls.push(binary);
            const version=binary===settings.current?settings.currentVersion||'20.0.0'
                :binary===settings.pathNode?settings.pathVersion||'20.0.0'
                :binary.includes('codex-runtimes')?'24.19.0':binary.match(/node-v(\\d+\\.\\d+\\.\\d+)-/)?.[1];
            return version?{status:0,stdout:JSON.stringify({version,binary})}:{status:1,stdout:''};
        };
        syncBuiltinESMExports();
    `);
    await fs.writeFile(runner, `
        import {nodeRuntime} from ${JSON.stringify(pathToFileURL(path.join(checkout, 'scripts/workspace/node-runtime.mjs')).href)};
        const environment=JSON.parse(process.env.RUNTIME_FIXTURE_ENV);
        const selected=nodeRuntime(environment);
        console.log(JSON.stringify({node:selected.node,version:selected.version,calls:globalThis.runtimeCalls}));
    `);
    function run(settings = {}, environment = {}) {
        const result = spawnSync(process.execPath, ['--import', hook, runner], {cwd: checkout, encoding: 'utf8', timeout: 10000,
            env: {RUNTIME_FIXTURE_SETTINGS: JSON.stringify({platform, arch, current, pathNode, ...settings}),
                RUNTIME_FIXTURE_ENV: JSON.stringify({PATH: path.dirname(pathNode), ...environment})}});
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    }
    return {run, current, pathNode, expected: path.join(toolchains, `node-v24.22.0-${platform}-${arch}/bin/node`)};
}

for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['linux', 'x64']]) {
    test(`Проектный toolchain ${platform}/${arch} выбирает лучший полный Node 24 до Codex runtime`, async t => {
        const f = await projectRuntimeFixture(t, platform, arch), selected = f.run();
        assert.equal(selected.node, f.expected);
        assert.equal(selected.version, '24.22.0');
        assert.deepEqual(selected.calls, [f.current, f.pathNode, f.expected]);
    });
}

test('Работающий current или PATH сохраняет приоритет перед проектным toolchain', async t => {
    const f = await projectRuntimeFixture(t, 'darwin', 'arm64');
    const current = f.run({currentVersion: '24.10.0'});
    assert.equal(current.node, f.current);
    assert.deepEqual(current.calls, [f.current]);
    const fromPath = f.run({pathVersion: '24.11.0'});
    assert.equal(fromPath.node, f.pathNode);
    assert.deepEqual(fromPath.calls, [f.current, f.pathNode]);
});

test('Dev-команда соблюдает явный npm CLI и запускает его выбранным Node во всех пакетах', async () => {
    const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter dev runtime ')));
    try {
        const cli = path.join(temporary, 'npm-cli.js'), records = path.join(temporary, 'calls.jsonl');
        await fs.writeFile(cli, `require('node:fs').appendFileSync(${JSON.stringify(records)},JSON.stringify({node:process.versions.node,cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');`);
        const checkout = path.join(temporary, 'checkout'), bin = path.join(temporary, 'bin'), dockerConfig = path.join(temporary, 'docker');
        await fs.mkdir(path.join(checkout, 'scripts/workspace'), {recursive: true});
        await fs.mkdir(bin); await fs.mkdir(dockerConfig);
        for (const file of ['dev.mjs', 'workspace/node-runtime.mjs', 'workspace/compose.mjs', 'workspace/compose.lock.json', 'workspace/dev-output.mjs', 'workspace/dev-processes.mjs']) {
            await fs.copyFile(path.join(root, 'scripts', file), path.join(checkout, 'scripts', file));
        }
        for(const directory of ['models','embedding','vision'])await fs.cp(path.join(root,'scripts',directory),path.join(checkout,'scripts',directory),{recursive:true});
        await fs.copyFile(path.join(root,'scripts/release-request.mjs'),path.join(checkout,'scripts/release-request.mjs'));
        await fs.mkdir(path.join(checkout,'scripts/assets'));
        await fs.copyFile(path.join(root,'scripts/assets/startup.mjs'),path.join(checkout,'scripts/assets/startup.mjs'));
        await fs.copyFile(path.join(root,'scripts/workspace/catalog-startup.mjs'),path.join(checkout,'scripts/workspace/catalog-startup.mjs'));
        for (const directory of workspacePackages) await fs.mkdir(path.join(checkout, directory), {recursive: true});
        await fs.writeFile(path.join(bin, 'docker'), `#!${process.execPath}
            const args=process.argv.slice(2).join(' ');
            if(args==='--version')console.log('Docker version 27.5.1, build fixture');
            else if(args==='compose version --short')console.log('2.40.3');
            else if(args==='compose up --help')console.log('--wait --wait-timeout');
            else process.exitCode=91;`, {mode: 0o700});
        const tripwire = path.join(temporary, 'network-tripwire.mjs'), networkCalls = path.join(temporary, 'network-calls');
        await fs.writeFile(tripwire, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
            import {appendFileSync} from 'node:fs';
            import {syncBuiltinESMExports} from 'node:module';
            const deny=()=>{appendFileSync(${JSON.stringify(networkCalls)},'attempt\\n');throw Error('REAL_NETWORK_FORBIDDEN');}; globalThis.fetch=deny;
            http.request=http.get=https.request=https.get=net.connect=net.createConnection=deny; syncBuiltinESMExports();`);
        const result = spawnSync(process.execPath, [path.join(checkout, 'scripts/dev.mjs'), 'install'], {
            cwd: checkout, env: {PATH: bin, NODE_BIN: process.execPath, NPM_CLI_JS: cli, DOCKER_CONFIG: dockerConfig,
                NODE_OPTIONS: `--import=${pathToFileURL(tripwire).href}`}, encoding: 'utf8', timeout: 10000,
        });
        assert.equal(result.status, 0, result.stderr);
        const calls = (await fs.readFile(records, 'utf8')).trim().split('\n').map(value => JSON.parse(value));
        assert.deepEqual(calls.map(call => path.relative(checkout, call.cwd)).sort(), [...workspacePackages].sort());
        for (const call of calls) {assert.ok(Number(call.node.split('.')[0]) >= 24); assert.deepEqual(call.args, ['ci', '--no-audit', '--no-fund']);}
        assert.doesNotMatch(result.stderr, /REAL_NETWORK_FORBIDDEN/);
        await assert.rejects(fs.access(networkCalls), {code: 'ENOENT'});
        assert.deepEqual(await fs.readdir(dockerConfig), []);
    } finally {await fs.rm(temporary, {recursive: true, force: true});}
});

test('Общий check проверяет свежий dist, новые контракты и авторизацию, не запускает live-сценарии', () => {
    const files = nodeTestFiles(root), plan = checkPlan(root);
    for (const file of ['scripts/test/auth-security.mjs', 'scripts/test/blitz-flow.test.mjs', 'scripts/test/tool-runtime-source.test.mjs',
        'scripts/test/repository-source.test.mjs', 'scripts/catalog-plugins/test/runtime-source.test.mjs', 'scripts/test/workspace-check.test.mjs',
        'scripts/test/compose-install-integration.test.mjs',
        'scripts/test/vision-hosting.test.mjs', 'scripts/test/vision-input.test.mjs', 'scripts/test/vision-image-fixture.test.mjs']) assert.ok(files.includes(file), file);
    assert.equal(files.length, new Set(files).size);
    assert.ok(!files.includes('scripts/test/qa-api.mjs')); assert.ok(!files.includes('scripts/test/production-stack.mjs'));
    for (const directory of workspacePackages) {
        const build = plan.findIndex(step => step.directory === directory && step.args.includes('build'));
        const typecheck = plan.findIndex(step => step.directory === directory && step.args.includes('typecheck'));
        assert.ok(typecheck >= 0 && build > typecheck);
    }
    const common = plan.findIndex(step => step.type === 'node');
    assert.ok(plan.slice(common + 1).every(step => step.type === 'compose'));
    assert.ok(plan.slice(0, common).some(step => step.directory === 'mcp/neurocenter-asset-sync' && step.args.includes('build')));
});
