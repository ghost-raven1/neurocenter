import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {workspacePackages} from '../workspace/check-plan.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Точная копия dev/helper работает только с собственными командами, данными и окружением. */
async function fixture(t, mode = 'ready') {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter compose integration ')));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const checkout = path.join(directory, 'checkout'), bin = path.join(directory, 'bin');
    const dockerConfig = path.join(directory, 'docker'), records = path.join(directory, 'calls.jsonl');
    await fs.mkdir(path.join(checkout, 'scripts/workspace'), {recursive: true});
    await fs.mkdir(bin); await fs.mkdir(dockerConfig);
    for (const file of ['dev.mjs', 'release-request.mjs', 'workspace/node-runtime.mjs', 'workspace/model-credentials.mjs', 'workspace/model-credential-store.mjs', 'workspace/dev-model-credentials.mjs', 'workspace/dev-snapshots.mjs', 'workspace/dev-chat-storage.mjs', 'workspace/npm-build-environment.mjs', 'workspace/docker-build-ca.mjs', 'workspace/compose.mjs',
        'workspace/compose.lock.json', 'workspace/dev-output.mjs', 'workspace/dev-processes.mjs']) {
        await fs.copyFile(path.join(root, 'scripts', file), path.join(checkout, 'scripts', file));
    }
    await fs.mkdir(path.join(checkout, 'scripts/assets'));
    await fs.copyFile(path.join(root, 'scripts/assets/startup.mjs'), path.join(checkout, 'scripts/assets/startup.mjs'));
    for (const directory of ['models', 'embedding', 'snapshots']) {
        await fs.cp(path.join(root, 'scripts', directory), path.join(checkout, 'scripts', directory), {recursive: true});
    }
    for (const packageDirectory of workspacePackages) await fs.mkdir(path.join(checkout, packageDirectory), {recursive: true});
    const config = '{"credsStore":"own-fixture","currentContext":"own-context"}\n';
    await fs.writeFile(path.join(dockerConfig, 'config.json'), config);
    const record = `const record=value=>require('node:fs').appendFileSync(process.env.COMPOSE_TEST_RECORD,JSON.stringify(value)+'\\n');`;
    await fs.writeFile(path.join(bin, 'docker'), `#!${process.execPath}
        ${record}
        const args=process.argv.slice(2); record({kind:'docker',args,dockerConfig:process.env.DOCKER_CONFIG});
        const command=args.join(' '), mode=process.env.COMPOSE_TEST_MODE;
        if(command==='--version') {if(mode==='missing-docker')process.exitCode=127;else console.log('Docker version 27.5.1, build fixture');}
        else if(command==='compose version --short') {if(mode==='provision-failure')process.exitCode=1;else console.log('2.40.3');}
        else if(command==='compose up --help')console.log('--wait --wait-timeout');
        else if(command==='info --format {{.ServerVersion}}') {if(mode==='daemon-down')process.exitCode=1;else console.log('27.5.1');}
        else {record({kind:'unexpected-command',args});process.exitCode=91;}`, {mode: 0o700});
    // Only the copied fixture supplies this hook; no real runtime, installer or home is reached.
    await fs.writeFile(path.join(checkout, 'scripts/workspace/dev-bridge-runtime.mjs'), `export async function prepareDevBridge({root,node,environment}) {
        const fs=await import('node:fs');fs.appendFileSync(environment.COMPOSE_TEST_RECORD,JSON.stringify({kind:'bridge-pipeline',root,node,home:environment.HOME})+'\\n');
        if(environment.COMPOSE_TEST_MODE==='bridge-pipeline-failure')throw Error('OWN_BRIDGE_PIPELINE_FAILURE');
        return {installed:{updated:true}};
    }`);
    const npm = path.join(directory, 'npm-cli.js');
    await fs.writeFile(npm, `${record}
        record({kind:'npm',node:process.versions.node,args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME});`);
    const hook = path.join(directory, 'network-tripwire.mjs');
    await fs.writeFile(hook, `import {appendFileSync} from 'node:fs';
        import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
        import {syncBuiltinESMExports} from 'node:module';
        const record=value=>appendFileSync(process.env.COMPOSE_TEST_RECORD,JSON.stringify(value)+'\\n');
        const deny=()=>{record({kind:'unexpected-network'});throw Error('REAL_NETWORK_FORBIDDEN');};
        globalThis.fetch=(...args)=>{
            if(process.env.COMPOSE_TEST_MODE!=='provision-failure')return deny();
            record({kind:'fetch-fixture',url:String(args[0])});return Promise.resolve(new Response('',{status:503}));
        };
        http.request=http.get=https.request=https.get=net.connect=net.createConnection=deny;syncBuiltinESMExports();`);
    const env = {PATH: bin, NODE_BIN: process.execPath, NPM_CLI_JS: npm, DOCKER_CONFIG: dockerConfig,
        HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: path.join(directory, 'config'),
        NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`, COMPOSE_TEST_MODE: mode, COMPOSE_TEST_RECORD: records};
    async function run(command = 'install') {
        const result = spawnSync(process.execPath, [path.join(checkout, 'scripts/dev.mjs'), command], {
            cwd: checkout, env, encoding: 'utf8', timeout: 10000,
        });
        assert.equal(result.error, undefined);
        const events = await fs.readFile(records, 'utf8').then(value => value.trim().split('\n').filter(Boolean).map(JSON.parse),
            error => {if (error.code === 'ENOENT') return []; throw error;});
        assert.ok(events.every(event => !['unexpected-command', 'unexpected-network'].includes(event.kind)));
        assert.doesNotMatch(result.stderr, /REAL_NETWORK_FORBIDDEN/);
        assert.equal(await fs.readFile(path.join(dockerConfig, 'config.json'), 'utf8'), config);
        for (const event of events.filter(event => event.kind === 'docker')) assert.equal(event.dockerConfig, dockerConfig);
        return {...result, events};
    }
    return {directory, checkout, dockerConfig, run};
}

test('dev install проверяет готовый Compose до установки всех пакетов', async t => {
    const f = await fixture(t), result = await f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events.slice(0, 3).map(event => event.args), [
        ['--version'], ['compose', 'version', '--short'], ['compose', 'up', '--help'],
    ]);
    assert.deepEqual(result.events.map(event => event.kind), [...Array(3).fill('docker'), ...Array(workspacePackages.length+1).fill('npm'), 'bridge-pipeline']);
    const npm = result.events.filter(event => event.kind === 'npm');
    assert.deepEqual(npm.map(event => path.relative(f.checkout, event.cwd)).sort(), ['',...workspacePackages].sort());
    for (const event of npm) {
        assert.equal(event.node, process.versions.node);
        const base = event.cwd===f.checkout?['ci', '--ignore-scripts', '--no-audit', '--no-fund']:['ci', '--no-audit', '--no-fund'];
        const strict = path.relative(f.checkout,event.cwd)==='services/api-gateway'?'false':'true';
        assert.deepEqual(event.args,[...base,'--registry=https://registry.npmjs.org/','--strict-ssl='+strict,'--userconfig='+path.join(event.home,'user.npmrc'),'--globalconfig='+path.join(event.home,'global.npmrc')]);
        assert.match(path.basename(event.home),/^neurocenter-npm-build-/);
        await assert.rejects(fs.access(event.home),{code:'ENOENT'});
    }
    assert.deepEqual(result.events.at(-1),{kind:'bridge-pipeline',root:f.checkout+path.sep,node:process.execPath,home:f.directory});
    assert.match(result.stdout, /Compose 2\.40\.3 уже установлен/);
    assert.deepEqual(await fs.readdir(f.dockerConfig), ['config.json']);
});

test('dev install reports bridge pipeline failure after all npm and does not claim completion',async t=>{
    const f=await fixture(t,'bridge-pipeline-failure'),result=await f.run();
    assert.equal(result.status,1);assert.match(result.stderr,/OWN_BRIDGE_PIPELINE_FAILURE/);assert.doesNotMatch(result.stdout,/Зависимости установлены/);
    assert.deepEqual(result.events.map(event=>event.kind),[...Array(3).fill('docker'),...Array(workspacePackages.length+1).fill('npm'),'bridge-pipeline']);
});

test('dev install останавливается при недоступном Docker CLI до первого npm', async t => {
    const f = await fixture(t, 'missing-docker'), result = await f.run();
    assert.equal(result.status, 1); assert.match(result.stderr, /Не найден Docker CLI/);
    assert.deepEqual(result.events.map(event => [event.kind, event.args]), [['docker', ['--version']]]);
    assert.deepEqual(await fs.readdir(f.dockerConfig), ['config.json']);
});

test('dev install останавливается при отказе загрузки Compose до первого npm и очищает свои временные файлы', async t => {
    const f = await fixture(t, 'provision-failure'), result = await f.run();
    assert.equal(result.status, 1); assert.match(result.stderr, /Не удалось скачать Compose: HTTP 503/);
    assert.deepEqual(result.events.map(event => event.kind), ['docker', 'docker', 'docker', 'fetch-fixture']);
    assert.equal(result.events.filter(event => event.kind === 'npm').length, 0);
    assert.deepEqual(await fs.readdir(path.join(f.dockerConfig, 'cli-plugins')), []);
});

test('dev up при недоступном daemon не начинает сборку и не останавливает прежний экземпляр', async t => {
    const f = await fixture(t, 'daemon-down');
    await fs.mkdir(path.join(f.checkout, '.run'));
    const stateFile = path.join(f.checkout, '.run/processes.json'), state = '[]\n';
    await fs.writeFile(stateFile, state);
    const result = await f.run('up');
    assert.equal(result.status, 1); assert.match(result.stderr, /Docker Engine недоступен/);
    assert.deepEqual(result.events.map(event => event.kind), Array(4).fill('docker'));
    assert.deepEqual(result.events.at(-1).args, ['info', '--format', '{{.ServerVersion}}']);
    assert.equal(await fs.readFile(stateFile, 'utf8'), state);
    await assert.rejects(fs.access(path.join(f.checkout, '.run/logs')), {code: 'ENOENT'});
});
