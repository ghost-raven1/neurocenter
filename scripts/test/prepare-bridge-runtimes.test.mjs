import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {opencodeVersion} from '../opencode-platforms.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const version = '9.8.7';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const distSource = 'console.log("isolated bridge runtime");\n';
const buildId = hash('index.js\0' + distSource);
const archiveName = target => `neurocenter-asset-sync-${target}-${version}.tgz`;
const contextScripts = ['package-bridge-runtime.mjs', 'bridge-build-integrity.mjs', 'bridge-runtime-probe.mjs',
    'bridge-windows-job.mjs', 'opencode-platforms.mjs', 'workspace/node-runtime.mjs'];

/** Отдельный checkout и фальшивые сборщики: настоящий Docker, npm и сеть не используются. */
async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter runtime prepare ')));
    const active = new Set();
    function kill(child) {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    t.after(async () => {
        const closed = [...active].map(child => new Promise(resolve => child.once('close', resolve)));
        for (const child of active) kill(child);
        await Promise.all(closed);
        await fs.rm(root, {recursive: true, force: true});
    });
    const calls = path.join(root, 'calls.jsonl'), bin = path.join(root, 'fake-bin');
    const runtime = path.join(root, 'bridge-dist/runtime');
    const bridge = path.join(root, 'mcp/neurocenter-asset-sync');
    await fs.mkdir(path.join(root, 'scripts/workspace'), {recursive: true});
    await fs.mkdir(path.join(bridge, 'dist'), {recursive: true});
    await fs.mkdir(bin);
    for (const file of ['prepare-bridge-runtimes.mjs', 'bridge-runtime-artifacts.mjs', 'release-request.mjs', ...contextScripts]) {
        await fs.copyFile(path.join(repository, 'scripts', file), path.join(root, 'scripts', file));
    }
    await fs.mkdir(path.join(root, 'node_modules/@neurocenter'), {recursive: true});
    await fs.symlink(path.join(repository, 'node_modules/@neurocenter/asset-contract'), path.join(root, 'node_modules/@neurocenter/asset-contract'), 'dir');
    await fs.mkdir(path.join(root, 'bridge-dist'), {recursive: true});
    for (const file of ['install.sh', 'install.ps1']) {
        await fs.copyFile(path.join(repository, 'bridge-dist', file), path.join(root, 'bridge-dist', file));
    }
    await fs.mkdir(path.join(root, 'services/api-gateway'), {recursive: true});
    await fs.copyFile(path.join(repository, 'services/api-gateway/Dockerfile'), path.join(root, 'services/api-gateway/Dockerfile'));
    await fs.writeFile(path.join(bridge, 'package.json'), JSON.stringify({name: 'isolated-bridge', version}));
    await fs.writeFile(path.join(bridge, 'package-lock.json'), JSON.stringify({name: 'isolated-bridge', version, lockfileVersion: 3}));
    await fs.writeFile(path.join(bridge, 'dist/index.js'), distSource);
    await fs.writeFile(path.join(bridge, 'dist/build.json'), JSON.stringify({version, buildId}));
    for (const file of ['.env', '.env.local', '.git/config', 'node_modules/host-private.js',
        'mcp/neurocenter-asset-sync/node_modules/host-native.node', 'data/private.txt']) {
        await fs.mkdir(path.dirname(path.join(root, file)), {recursive: true});
        await fs.writeFile(path.join(root, file), 'PRIVATE_FIXTURE_MUST_NOT_ENTER_CONTAINER');
    }
    await fs.writeFile(path.join(root, 'scripts/prepare-opencode.mjs'), `
        import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
        const root=process.env.RUNTIME_FIXTURE_ROOT;
        await fs.appendFile(process.env.RUNTIME_FIXTURE_CALLS,JSON.stringify({kind:'prepare-opencode',targets:process.env.OPENCODE_TARGETS,version:process.env.OPENCODE_VERSION})+'\\n');
        const output=path.join(root,'bridge-dist/opencode');await fs.mkdir(output,{recursive:true});
        const file=path.join(output,'opencode-'+process.env.OPENCODE_TARGETS+'-'+process.env.OPENCODE_VERSION+'.tgz');
        const bytes=Buffer.from('isolated opencode probe');
        await fs.writeFile(file,bytes);await fs.writeFile(file+'.sha256',createHash('sha256').update(bytes).digest('hex')+'\\n');
    `);
    await fs.writeFile(path.join(root, 'scripts/package-bridge-runtime.mjs'), `
        import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
        const root=process.env.RUNTIME_FIXTURE_ROOT,output=process.env.BRIDGE_RUNTIME_OUTPUT_DIR;
        if(!output?.startsWith(path.join(root,'.run')+path.sep))throw Error('Native builder received live output');
        await fs.appendFile(process.env.RUNTIME_FIXTURE_CALLS,JSON.stringify({kind:'native-build',output})+'\\n');
        const manifest=JSON.parse(await fs.readFile(path.join(root,'mcp/neurocenter-asset-sync/package.json'),'utf8'));
        const build=JSON.parse(await fs.readFile(path.join(root,'mcp/neurocenter-asset-sync/dist/build.json'),'utf8'));
        const target=process.platform+'-'+process.arch,file=path.join(output,'neurocenter-asset-sync-'+target+'-'+manifest.version+'.tgz');
        const bytes=Buffer.from('isolated native runtime'),digest=createHash('sha256').update(bytes).digest('hex');
        await fs.mkdir(output,{recursive:true});await fs.writeFile(file,bytes);
        if(process.env.RUNTIME_FIXTURE_MODE==='fail-after-archive')process.exit(61);
        const metadata={version:manifest.version,target,buildId:build.buildId,nodeVersion:'24.22.0',ragSupported:true,
            probeEngine:{version:process.env.RUNTIME_FIXTURE_OPENCODE,file:'bin/opencode-probe',sha256:'a'.repeat(64)},bytes:bytes.length,sha256:digest};
        await fs.writeFile(file+'.json',JSON.stringify(metadata));await fs.writeFile(file+'.sha256',digest+'\\n');
    `);
    await fs.writeFile(path.join(bin, 'docker'), `#!${process.execPath}
        const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
        const args=process.argv.slice(2),mounts=[];
        for(let i=0;i<args.length;i++)if(args[i]==='--volume'){
            const [source,destination,mode]=args[++i].split(':');mounts.push({source,destination,mode});
        }
        const workspace=mounts.find(item=>item.destination==='/workspace')?.source;
        const output=mounts.find(item=>item.destination==='/workspace/bridge-dist/runtime')?.source;
        if(!workspace||!output)throw Error('Unknown Docker mount contract');
        const files=fs.readdirSync(workspace,{recursive:true}).filter(file=>fs.statSync(path.join(workspace,file)).isFile()).sort();
        fs.appendFileSync(process.env.RUNTIME_FIXTURE_CALLS,JSON.stringify({kind:'docker',args,mounts,files})+'\\n');
        if(process.env.RUNTIME_FIXTURE_MODE==='wait-builder'){
            fs.writeFileSync(path.join(process.env.RUNTIME_FIXTURE_ROOT,'builder-started'),'ready');
            const until=Date.now()+10000,waiting=new Int32Array(new SharedArrayBuffer(4));
            while(!fs.existsSync(path.join(process.env.RUNTIME_FIXTURE_ROOT,'release-builder'))&&Date.now()<until)Atomics.wait(waiting,0,0,20);
            if(!fs.existsSync(path.join(process.env.RUNTIME_FIXTURE_ROOT,'release-builder')))throw Error('Fixture builder release timed out');
        }
        const target=args[args.indexOf('--platform')+1]==='linux/amd64'?'linux-x64':'linux-arm64';
        const manifest=JSON.parse(fs.readFileSync(path.join(workspace,'mcp/neurocenter-asset-sync/package.json'),'utf8'));
        const build=JSON.parse(fs.readFileSync(path.join(workspace,'mcp/neurocenter-asset-sync/dist/build.json'),'utf8'));
        const name='neurocenter-asset-sync-'+target+'-'+manifest.version+'.tgz';
        fs.mkdirSync(output,{recursive:true});
        const bytes=Buffer.from(process.env.RUNTIME_FIXTURE_MODE==='fail-after-archive'?'incomplete replaced archive':'built isolated runtime '+target);
        fs.writeFileSync(path.join(output,name),bytes);
        if(process.env.RUNTIME_FIXTURE_MODE==='fail-after-archive')process.exit(61);
        const digest=createHash('sha256').update(bytes).digest('hex');
        const metadata={version:manifest.version,target,buildId:build.buildId,nodeVersion:'24.22.0',ragSupported:true,
            probeEngine:{version:process.env.RUNTIME_FIXTURE_OPENCODE,file:'bin/opencode-probe',sha256:'a'.repeat(64)},bytes:bytes.length,sha256:digest};
        if(process.env.RUNTIME_FIXTURE_MODE==='bad-candidate-sha')metadata.sha256='0'.repeat(64);
        fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify(metadata));
        fs.writeFileSync(path.join(output,name+'.sha256'),digest+'\\n');
    `, {mode: 0o700});
    const hook = path.join(root, 'isolated-host.mjs');
    await fs.writeFile(hook, `
        import fs from 'node:fs';import childProcess from 'node:child_process';
        import http from 'node:http';import https from 'node:https';import net from 'node:net';
        import {syncBuiltinESMExports} from 'node:module';
        const [platform,arch]=(process.env.RUNTIME_FIXTURE_HOST||'darwin-arm64').split('-');
        Object.defineProperty(process,'platform',{value:platform});
        Object.defineProperty(process,'arch',{value:arch});
        if(platform==='linux')process.report.getReport=()=>({header:{glibcVersionRuntime:'2.36'}});
        if(process.env.RUNTIME_FIXTURE_NODE_MAJOR)Object.defineProperty(process.versions,'node',{value:process.env.RUNTIME_FIXTURE_NODE_MAJOR+'.0.0'});
        const record=value=>fs.appendFileSync(process.env.RUNTIME_FIXTURE_CALLS,JSON.stringify(value)+'\\n');
        const deny=()=>{record({kind:'unexpected-network'});throw Error('REAL_NETWORK_FORBIDDEN');};
        globalThis.fetch=async ()=>deny();
        http.request=http.get=https.request=https.get=net.connect=net.createConnection=deny;
        net.Server.prototype.listen=deny;
        const rename=fs.promises.rename;
        let publishFailed=false;
        fs.promises.rename=async function(source,destination){
            if(process.env.RUNTIME_FIXTURE_MODE==='publish-failure'&&!publishFailed&&String(source).includes('/result/')
                &&String(source).endsWith('.tgz.sha256')&&String(destination).startsWith(process.env.RUNTIME_FIXTURE_ROOT+'/bridge-dist/runtime/')){
                publishFailed=true;record({kind:'publish-failure'});
                throw Object.assign(new Error('ENOSPC: fixture publish failed'),{code:'ENOSPC'});
            }
            return rename.call(this,source,destination);
        };
        const original=childProcess.execFileSync;
        childProcess.execFileSync=function(command,args,options){
            record({kind:'exec',command,args});
            const nativeScript=['prepare-opencode.mjs','package-bridge-runtime.mjs'].some(name=>args?.[0]===process.env.RUNTIME_FIXTURE_ROOT+'/scripts/'+name);
            if(command!=='docker'&&!(command===process.execPath&&nativeScript)){
                throw Error('REAL_BUILDER_FORBIDDEN');
            }
            return original.call(this,command,args,options);
        };
        childProcess.spawn=childProcess.spawnSync=()=>{throw Error('REAL_BUILDER_FORBIDDEN');};
        syncBuiltinESMExports();
    `);
    async function events() {
        try { return (await fs.readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }
    async function seed(target, overrides = {}) {
        await fs.mkdir(runtime, {recursive: true});
        const bytes = Buffer.from('previous isolated runtime ' + target), digest = hash(bytes);
        const metadata = {version, target, buildId, nodeVersion: '24.22.0', ragSupported: true,
            probeEngine: {version: opencodeVersion, file: 'bin/opencode-probe', sha256: 'a'.repeat(64)},
            bytes: bytes.length, sha256: digest, ...overrides};
        const file = path.join(runtime, archiveName(target));
        await fs.writeFile(file, bytes);
        await fs.writeFile(file + '.json', JSON.stringify(metadata));
        await fs.writeFile(file + '.sha256', digest + '\n');
        return file;
    }
    function environment(overrides) {
        return {
                PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
                NODE_OPTIONS: '--import=' + pathToFileURL(hook).href,
                RUNTIME_FIXTURE_ROOT: root, RUNTIME_FIXTURE_CALLS: calls, RUNTIME_FIXTURE_OPENCODE: opencodeVersion,
                ...overrides,
        };
    }
    async function checked(result) {
        assert.equal(result.error, undefined);
        const recorded = await events();
        assert.ok(recorded.every(event => event.kind !== 'unexpected-network'));
        assert.doesNotMatch(result.stderr, /REAL_NETWORK_FORBIDDEN|REAL_BUILDER_FORBIDDEN/);
        return {...result, events: recorded};
    }
    function run(args = [], overrides = {}) {
        return checked(spawnSync(process.execPath, [path.join(root, 'scripts/prepare-bridge-runtimes.mjs'), ...args], {
            cwd: root, encoding: 'utf8', timeout: 15000, env: environment(overrides),
        }));
    }
    function start(args, overrides) {
        const child = spawn(process.execPath, [path.join(root, 'scripts/prepare-bridge-runtimes.mjs'), ...args], {
            cwd: root, env: environment(overrides), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        });
        active.add(child);
        let stdout = '', stderr = '';
        child.stdout.setEncoding('utf8').on('data', value => {stdout += value;});
        child.stderr.setEncoding('utf8').on('data', value => {stderr += value;});
        const timer = setTimeout(() => kill(child), 15000);
        const completion = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (status, signal) => {active.delete(child); resolve({status, signal, stdout, stderr});});
        }).finally(() => clearTimeout(timer)).then(checked);
        return {completion};
    }
    return {root, runtime, seed, run, start};
}

test('Linux producer builds only its default target without downloading a published release', async t => {
    const f = await fixture(t);
    const result = await f.run([], {RUNTIME_FIXTURE_HOST: 'linux-x64'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.events.filter(event => event.kind === 'release-download').length, 0);
    assert.equal(result.events.filter(event => event.kind === 'native-build').length, 1);
    const asset = JSON.parse(await fs.readFile(path.join(f.runtime, `neurocenter-bridge-${version}.asset.json`), 'utf8'));
    assert.equal(asset.schemaVersion, 1); assert.equal(asset.kind, 'bridge');
    assert.equal(asset.source.repository, 'https://github.com/ghost-raven1/neurocenter-assets');
    assert.deepEqual(asset.delivery.release.artifacts.map(item => item.metadata.target), ['linux-x64']);
    await assert.rejects(fs.access(path.join(f.runtime, archiveName('darwin-arm64'))), {code: 'ENOENT'});
});

test('Проверенный кеш текущего хоста и Linux x64 не запускает процессы и сеть', async t => {
    const f = await fixture(t);
    await f.seed('darwin-arm64');await f.seed('linux-x64');
    const result = await f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events, []);
    assert.match(await fs.readFile(path.join(f.root, 'bridge-dist/install.sh'), 'utf8'), /^VERSION='__BRIDGE_VERSION__'$/m);
    assert.match(await fs.readFile(path.join(f.root, 'bridge-dist/install.ps1'), 'utf8'), /^\$Version = '__BRIDGE_VERSION__'$/m);
});

test('BRIDGE_RUNTIME_TARGETS выбирает только явно указанный готовый пакет', async t => {
    const f = await fixture(t);await f.seed('linux-x64');
    const result = await f.run([], {BRIDGE_RUNTIME_TARGETS: 'linux-x64'});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events, []);
});

test('Недостающий Linux x64 собирается через linux/amd64 с минимальным открытым контекстом', async t => {
    const f = await fixture(t), result = await f.run(['--targets=linux-x64']);
    assert.equal(result.status, 0, result.stderr);
    const docker = result.events.find(event => event.kind === 'docker');
    assert.ok(docker);
    assert.equal(docker.args[docker.args.indexOf('--platform') + 1], 'linux/amd64');
    assert.ok(docker.args.some(value => /^node:24\.22\.0-bookworm-slim@sha256:[a-f0-9]{64}$/.test(value)));
    assert.equal(docker.mounts.length, 2);
    const workspace = docker.mounts.find(item => item.destination === '/workspace');
    assert.equal(workspace.mode, 'ro');
    assert.ok(workspace.source.startsWith(path.join(f.root, '.run') + path.sep));
    assert.ok(docker.mounts.every(item => item.source.startsWith(f.root + path.sep)));
    assert.notEqual(docker.mounts.find(item => item.destination === '/workspace/bridge-dist/runtime').source, f.runtime);
    const expected = [...contextScripts.map(name => 'scripts/' + name),
        'mcp/neurocenter-asset-sync/dist/index.js', 'mcp/neurocenter-asset-sync/dist/build.json',
        'mcp/neurocenter-asset-sync/package.json', 'mcp/neurocenter-asset-sync/package-lock.json',
        `bridge-dist/opencode/opencode-linux-x64-baseline-${opencodeVersion}.tgz`,
        `bridge-dist/opencode/opencode-linux-x64-baseline-${opencodeVersion}.tgz.sha256`].sort();
    assert.deepEqual(docker.files, expected);
    const environment = docker.args.filter((_, index) => docker.args[index - 1] === '--env').sort();
    assert.deepEqual(environment, ['BRIDGE_RUNTIME_OUTPUT_DIR=/workspace/bridge-dist/runtime', 'HOME=/tmp', 'npm_config_cache=/tmp/npm-cache']);
    assert.deepEqual(result.events.filter(event => event.kind === 'prepare-opencode'), [
        {kind: 'prepare-opencode', targets: 'linux-x64-baseline', version: opencodeVersion},
    ]);
    const archive = path.join(f.runtime, archiveName('linux-x64')), bytes = await fs.readFile(archive);
    assert.equal((await fs.readFile(archive + '.sha256', 'utf8')).trim(), hash(bytes));
    assert.equal(JSON.parse(await fs.readFile(archive + '.json', 'utf8')).buildId, buildId);
});

test('Нативная сборка использует отдельный выход, проверяется и публикуется без Docker', async t => {
    const f = await fixture(t), result = await f.run(['--targets=darwin-arm64']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.events.filter(event => event.kind === 'docker').length, 0);
    const native = result.events.filter(event => event.kind === 'native-build');
    assert.equal(native.length, 1);
    assert.ok(native[0].output.startsWith(path.join(f.root, '.run') + path.sep));
    assert.notEqual(native[0].output, f.runtime);
    assert.deepEqual(result.events.filter(event => event.kind === 'prepare-opencode'), [
        {kind: 'prepare-opencode', targets: 'darwin-arm64', version: opencodeVersion},
    ]);
    const archive = path.join(f.runtime, archiveName('darwin-arm64'));
    assert.equal((await fs.readFile(archive + '.sha256', 'utf8')).trim(), hash(await fs.readFile(archive)));
    assert.equal(JSON.parse(await fs.readFile(archive + '.json', 'utf8')).buildId, buildId);
    assert.match(await fs.readFile(path.join(f.root, 'bridge-dist/install.sh'), 'utf8'), /^VERSION='__BRIDGE_VERSION__'$/m);
});

test('Сбой нативного сборщика после записи кандидата сохраняет предыдущий пакет', async t => {
    const f = await fixture(t), file = await f.seed('darwin-arm64', {buildId: 'f'.repeat(64)});
    const before = await Promise.all(['', '.json', '.sha256'].map(suffix => fs.readFile(file + suffix)));
    const result = await f.run(['--targets=darwin-arm64'], {RUNTIME_FIXTURE_MODE: 'fail-after-archive'});
    assert.notEqual(result.status, 0);
    assert.equal(result.events.filter(event => event.kind === 'native-build').length, 1);
    assert.equal(result.events.filter(event => event.kind === 'docker').length, 0);
    const after = await Promise.all(['', '.json', '.sha256'].map(suffix => fs.readFile(file + suffix)));
    assert.deepEqual(after, before);
});

for (const [mode, description] of [['bad-sha', 'неверной SHA'], ['old-build', 'устаревшем buildId']]) {
    test('Кеш пересобирается при ' + description, async t => {
        const f = await fixture(t), file = await f.seed('linux-x64', mode === 'old-build' ? {buildId: 'f'.repeat(64)} : {});
        if (mode === 'bad-sha') await fs.writeFile(file + '.sha256', '0'.repeat(64) + '\n');
        const result = await f.run(['--targets=linux-x64']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.events.filter(event => event.kind === 'docker').length, 1);
        assert.equal(JSON.parse(await fs.readFile(file + '.json', 'utf8')).buildId, buildId);
        assert.equal((await fs.readFile(file + '.sha256', 'utf8')).trim(), hash(await fs.readFile(file)));
    });
}

test('Сбой сборщика после записи архива сохраняет прежний согласованный комплект', async t => {
    const f = await fixture(t), file = await f.seed('linux-x64', {buildId: 'f'.repeat(64)});
    const before = await Promise.all(['', '.json', '.sha256'].map(suffix => fs.readFile(file + suffix)));
    const result = await f.run(['--targets=linux-x64'], {RUNTIME_FIXTURE_MODE: 'fail-after-archive'});
    assert.notEqual(result.status, 0);
    assert.equal(result.events.filter(event => event.kind === 'docker').length, 1);
    const after = await Promise.all(['', '.json', '.sha256'].map(suffix => fs.readFile(file + suffix)));
    assert.deepEqual(after, before);
    assert.deepEqual((await fs.readdir(f.runtime)).sort(), ['', '.json', '.sha256'].map(suffix => archiveName('linux-x64') + suffix).sort());
});

for (const [mode, description, error] of [
    ['bad-candidate-sha', 'Некорректная SHA кандидата', /не прошёл проверку/],
    ['publish-failure', 'Сбой публикации sidecar после архива', /ENOSPC/],
]) {
    test(description + ' сохраняет прежний комплект целиком', async t => {
        const f = await fixture(t), file = await f.seed('linux-x64', {buildId: 'f'.repeat(64)});
        const before = await Promise.all(['', '.json', '.sha256'].map(suffix => fs.readFile(file + suffix)));
        const result = await f.run(['--targets=linux-x64'], {RUNTIME_FIXTURE_MODE: mode});
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, error);
        assert.equal(result.events.filter(event => event.kind === 'docker').length, 1);
        if (mode === 'publish-failure') assert.equal(result.events.filter(event => event.kind === 'publish-failure').length, 1);
        const after = await Promise.all(['', '.json', '.sha256'].map(suffix => fs.readFile(file + suffix)));
        assert.deepEqual(after, before);
    });
}

for (const target of ['solaris-x64', 'windows-x64']) {
    test('Недоступная цель ' + target + ' отклоняется до запуска сборщиков', async t => {
        const f = await fixture(t), result = await f.run(['--targets=' + target]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Неизвестные цели|кросс-сборка этой цели недоступна/);
        assert.deepEqual(result.events, []);
    });
}

test('Linux x64 на Node.js 25 использует закреплённый Docker Node.js 24', async t => {
    const f = await fixture(t), result = await f.run(['--targets=linux-x64'], {
        RUNTIME_FIXTURE_HOST: 'linux-x64', RUNTIME_FIXTURE_NODE_MAJOR: '25',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.events.filter(event => event.kind === 'native-build').length, 0);
    assert.equal(result.events.filter(event => event.kind === 'docker').length, 1);
});

test('Нативная упаковка macOS на Node.js 25 объясняет требование до сборщиков и загрузок', async t => {
    const f = await fixture(t), result = await f.run(['--targets=darwin-arm64'], {RUNTIME_FIXTURE_NODE_MAJOR: '25'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /нативная упаковка требует Node\.js 24/);
    assert.match(result.stderr, /текущая версия 25/);
    assert.deepEqual(result.events, []);
});

test('Чужая блокировка отклоняет новую сборку и сохраняется целиком', async t => {
    const f = await fixture(t), lock = path.join(f.root, '.run/bridge-runtimes.lock');
    await fs.mkdir(lock, {recursive: true});
    await fs.writeFile(path.join(lock, 'owner'), 'another running preparation');
    const result = await f.run(['--targets=linux-x64']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /уже выполняется/);
    assert.match(result.stderr, /bridge-runtimes\.lock/);
    assert.deepEqual(result.events, []);
    assert.equal(await fs.readFile(path.join(lock, 'owner'), 'utf8'), 'another running preparation');
});

test('Готовый кеш читается при чужой блокировке без её удаления', async t => {
    const f = await fixture(t), lock = path.join(f.root, '.run/bridge-runtimes.lock');
    await f.seed('linux-x64');
    const initial = await f.run(['--targets=linux-x64']);
    assert.equal(initial.status, 0, initial.stderr);
    await fs.mkdir(lock, {recursive: true});
    await fs.writeFile(path.join(lock, 'owner'), 'do not delete');
    const result = await f.run(['--targets=linux-x64']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events, []);
    assert.equal(await fs.readFile(path.join(lock, 'owner'), 'utf8'), 'do not delete');
});

test('Exported descriptor is stable across repeats and argument ordering', async t => {
    const f = await fixture(t); await f.seed('darwin-arm64'); await f.seed('linux-x64');
    const first = await f.run(['--targets=linux-x64,darwin-arm64']);
    assert.equal(first.status, 0, first.stderr);
    const filename = path.join(f.runtime, `neurocenter-bridge-${version}.asset.json`);
    const before = await fs.readFile(filename);
    const repeated = await f.run(['--targets=darwin-arm64,linux-x64']);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(repeated.events, []);
    assert.deepEqual(await fs.readFile(filename), before);
});

test('Changing an exported platform set fails before building or replacing files', async t => {
    const f = await fixture(t); await f.seed('linux-x64');
    assert.equal((await f.run(['--targets=linux-x64'])).status, 0);
    const filename = path.join(f.runtime, `neurocenter-bridge-${version}.asset.json`);
    const before = await fs.readFile(filename);
    const result = await f.run(['--targets=linux-x64,darwin-arm64']);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Увеличьте версию/);
    assert.deepEqual(result.events, []); assert.deepEqual(await fs.readFile(filename), before);
    await assert.rejects(fs.access(path.join(f.runtime, archiveName('darwin-arm64'))), {code: 'ENOENT'});
});

test('A changed build cannot overwrite an already exported version', async t => {
    const f = await fixture(t); const archive = await f.seed('linux-x64');
    assert.equal((await f.run(['--targets=linux-x64'])).status, 0);
    const before = await fs.readFile(archive);
    const changed = 'console.log("changed build");\n';
    await fs.writeFile(path.join(f.root, 'mcp/neurocenter-asset-sync/dist/index.js'), changed);
    await fs.writeFile(path.join(f.root, 'mcp/neurocenter-asset-sync/dist/build.json'), JSON.stringify({version, buildId: hash('index.js\0' + changed)}));
    const result = await f.run(['--targets=linux-x64']);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Увеличьте версию/);
    assert.deepEqual(result.events, []); assert.deepEqual(await fs.readFile(archive), before);
});

test('Corrupt exported bytes are reported without silently publishing a replacement', async t => {
    const f = await fixture(t); const archive = await f.seed('linux-x64');
    assert.equal((await f.run(['--targets=linux-x64'])).status, 0);
    await fs.writeFile(archive, 'corrupt');
    const result = await f.run(['--targets=linux-x64']);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /повреждены/);
    assert.deepEqual(result.events, []); assert.equal(await fs.readFile(archive, 'utf8'), 'corrupt');
});

test('Параллельная подготовка отказывает до сборщика, пока первый процесс удерживает блокировку', async t => {
    const f = await fixture(t), first = f.start(['--targets=linux-x64'], {RUNTIME_FIXTURE_MODE: 'wait-builder'});
    const deadline = Date.now() + 5000;
    while (!await fs.access(path.join(f.root, 'builder-started')).then(() => true, () => false)) {
        assert.ok(Date.now() < deadline, 'Первый сборщик не запустился');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const competitor = await f.run(['--targets=linux-x64']);
    assert.notEqual(competitor.status, 0);
    assert.match(competitor.stderr, /уже выполняется/);
    assert.equal(competitor.events.filter(event => event.kind === 'docker').length, 1);
    assert.equal(competitor.events.filter(event => event.kind === 'prepare-opencode').length, 1);
    await fs.writeFile(path.join(f.root, 'release-builder'), 'continue');
    const completed = await first.completion;
    assert.equal(completed.status, 0, completed.stderr);
    const file = path.join(f.runtime, archiveName('linux-x64'));
    assert.equal((await fs.readFile(file + '.sha256', 'utf8')).trim(), hash(await fs.readFile(file)));
    assert.equal(JSON.parse(await fs.readFile(file + '.json', 'utf8')).sha256, hash(await fs.readFile(file)));
    await assert.rejects(fs.access(path.join(f.root, '.run/bridge-runtimes.lock')), {code: 'ENOENT'});
});
