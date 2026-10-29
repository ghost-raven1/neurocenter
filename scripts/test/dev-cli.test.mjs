import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {workspacePackages} from '../workspace/check-plan.mjs';
import {devServices} from '../workspace/dev-service-health.mjs';

import {healthHttpHook} from './dev-health-http-hook.fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const commands = ['install', 'build', 'check', 'up', 'down', 'status', 'tail'];

/** CLI работает с собственным checkout, логами и ответами health без доступа к живому стеку. */
async function fixture(t, mode = 'ready') {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter dev cli ')));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const checkout = path.join(directory, 'checkout'), logs = path.join(directory, 'логи сервисов'), bin = path.join(directory, 'bin');
    const record = path.join(directory, 'calls.jsonl');
    await fs.mkdir(path.join(checkout, 'scripts/workspace'), {recursive: true});
    await fs.mkdir(path.join(checkout, 'scripts/dev-mcp'), {recursive: true});
    await fs.mkdir(logs);
    await fs.mkdir(bin);
    for (const command of ['docker', 'ps']) {
        await fs.writeFile(path.join(bin, command), `#!${process.execPath}
            require('node:fs').appendFileSync(process.env.DEV_CLI_RECORD,JSON.stringify({kind:'unexpected-command',command:${JSON.stringify(command)}})+'\\n');
            process.exitCode=92;`, {mode: 0o700});
    }
    for (const file of ['dev.sh', 'dev.mjs', 'workspace/node-runtime.mjs', 'workspace/npm-build-environment.mjs', 'workspace/dev-chat-storage.mjs', 'workspace/model-credentials.mjs', 'workspace/model-credential-store.mjs', 'workspace/dev-model-credentials.mjs', 'workspace/dev-snapshots.mjs', 'workspace/docker-build-ca.mjs', 'workspace/docker-build-progress.mjs', 'workspace/compose.mjs',
        'workspace/compose.lock.json', 'workspace/dev-output.mjs', 'workspace/dev-processes.mjs', 'workspace/dev-launch-provenance.mjs', 'workspace/dev-launch-ack.mjs', 'workspace/dev-launch-inspection.mjs', 'workspace/dev-launch-recovery.mjs', 'workspace/dev-watch-owned.mjs', 'workspace/dev-watch-child.mjs', 'workspace/dev-service-health.mjs', 'workspace/dev-listener-origin.mjs', 'workspace/check-plan.mjs', 'workspace/node24-cli.mjs', 'dev-mcp/safe-file.mjs', 'dev-mcp/constants.mjs']) {
        await fs.copyFile(path.join(root, 'scripts', file), path.join(checkout, 'scripts', file));
    }
    await fs.mkdir(path.join(checkout,'scripts/assets'),{recursive:true});
    await fs.copyFile(path.join(root,'scripts/release-request.mjs'),path.join(checkout,'scripts/release-request.mjs'));
    await fs.copyFile(path.join(root,'scripts/assets/startup.mjs'),path.join(checkout,'scripts/assets/startup.mjs'));
    await fs.writeFile(path.join(checkout,'scripts/assets/selection.mjs'),'export async function selectStartupAssets(){return {}};');
    for(const directory of ['models','embedding','snapshots'])await fs.cp(path.join(root,'scripts',directory),path.join(checkout,'scripts',directory),{recursive:true});
    for (const packageDirectory of workspacePackages) await fs.mkdir(path.join(checkout, packageDirectory), {recursive: true});
    const npm = path.join(directory, 'npm-cli.js');
    await fs.writeFile(npm, `require('node:fs').appendFileSync(process.env.DEV_CLI_RECORD,JSON.stringify({kind:'npm',args:process.argv.slice(2),home:process.env.HOME,
        cwd:process.cwd(),configKeys:Object.keys(process.env).filter(key=>/^npm_config_/i.test(key)),hasToken:!!(process.env.NPM_TOKEN||process.env.NODE_AUTH_TOKEN)})+'\\n');
        process.exitCode=7;`);
    const hook = path.join(directory, 'isolated-network.mjs');
    await fs.writeFile(hook, `import {appendFileSync} from 'node:fs';
        import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
        import {syncBuiltinESMExports} from 'node:module';
        const record=value=>appendFileSync(process.env.DEV_CLI_RECORD,JSON.stringify(value)+'\\n');
        if(process.env.DEV_CLI_TTY==='1')for(const stream of [process.stdin,process.stdout])Object.defineProperty(stream,'isTTY',{value:true});
        const deny=()=>{record({kind:'unexpected-network'});throw Error('REAL_NETWORK_FORBIDDEN');};
        const timeout=AbortSignal.timeout.bind(AbortSignal);
        AbortSignal.timeout=ms=>{record({kind:'timeout',ms});return timeout(ms);};
        globalThis.fetch=async input=>{
            const url=new URL(input); record({kind:'health',port:url.port,path:url.pathname,search:url.search});
            if(!['22222','4100','4200','4300','4400','4000','5173'].includes(url.port))return deny();
            if(url.port==='5173'){
                const mode=process.env.DEV_CLI_MODE;
                if(mode==='frontend-error')return new Response('Process.cwd failed with error',{status:500});
                if(mode==='frontend-html')return new Response('<!doctype html><html></html>',{headers:{'Content-Type':'text/html'}});
                return new Response(mode==='frontend-empty'?' \\n ':'.ant-btn { color: #1677ff; }',{headers:{'Content-Type':'text/css; charset=utf-8'}});
            }
            const ok=(process.env.DEV_CLI_MODE!=='unavailable'||url.port!=='4300')&&!(process.env.DEV_CLI_MODE==='dependency-failed'&&url.port==='4100'&&url.pathname==='/ready');
            return new Response(JSON.stringify({ok}),{status:ok?200:503,headers:{'Content-Type':'application/json'}});
        };
        if(process.env.DEV_CLI_CORE_STARTUP==='1'){
            const {EventEmitter}=await import('node:events');
            net.createServer=()=>{const server=new EventEmitter();server.listen=()=>queueMicrotask(()=>server.emit('listening'));server.close=done=>queueMicrotask(done);return server;};
        }
        http.request=http.get=https.request=https.get=net.connect=net.createConnection=deny; syncBuiltinESMExports();
        ${healthHttpHook}`);
    const env = {PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), NODE_BIN: process.execPath, NPM_CLI_JS: npm, LOGDIR: logs,
        NO_COLOR: '1', TERM: 'dumb', NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
        DEV_CLI_RECORD: record, DEV_CLI_MODE: mode};
    async function run(...args) {
        if(args.length===1&&args[0]==='status'){await fs.mkdir(path.join(checkout,'.run/project-snapshots/secrets'),{recursive:true});await fs.writeFile(path.join(checkout,'.run/project-snapshots/secrets/verifier-token'),'a'.repeat(64)+'\n',{mode:0o600});}
        const result = spawnSync(path.join(checkout, 'scripts/dev.sh'), args, {
            cwd: checkout, env, encoding: 'utf8', timeout: 10000,
        });
        assert.equal(result.error, undefined);
        assert.doesNotMatch(result.stdout + result.stderr, /\x1b\[/);
        const events = await fs.readFile(record, 'utf8').then(value => value.trim().split('\n').filter(Boolean).map(JSON.parse),
            error => {if (error.code === 'ENOENT') return []; throw error;});
        assert.ok(events.every(event => !['unexpected-command', 'unexpected-network'].includes(event.kind)));
        assert.doesNotMatch(result.stderr, /REAL_NETWORK_FORBIDDEN/);
        return {...result, events};
    }
    return {checkout, logs, env, run};
}

for (const args of [[], ['--help'], ['—help'], ['help'], ['-h'], ['down', '--help'], ['up', '—help']]) {
    test(`CLI ${args.join(' ') || 'без аргументов'} показывает справку без запуска сервисов`, async t => {
        const f = await fixture(t), result = await f.run(...args);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.match(result.stdout, /scripts\/dev\.sh/);
        assert.match(result.stdout, /[А-Яа-яЁё]/);
        for (const command of commands) assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
        assert.deepEqual(result.events, []);
        await assert.rejects(fs.access(path.join(f.checkout, '.run')), {code: 'ENOENT'});
    });
}

test('Неизвестная команда возвращает ошибку, справку и ненулевой код', async t => {
    const f = await fixture(t), result = await f.run('unknown-command');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown-command/);
    assert.match(result.stderr, /[А-Яа-яЁё]/);
    for (const command of commands) assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
    assert.deepEqual(result.events, []);
});

test('Лишний аргумент отклоняется до сборки, Docker и остановки процессов', async t => {
    const f = await fixture(t), result = await f.run('up', 'extra-argument');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /extra-argument/);
    assert.match(result.stderr, /[А-Яа-яЁё]/);
    assert.deepEqual(result.events, []);
    await assert.rejects(fs.access(path.join(f.checkout, '.run')), {code: 'ENOENT'});
});

test('check передаёт выбор пакета и шага, сохраняя код отказа проверки', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.checkout, 'frontend/package.json'), JSON.stringify({scripts: {test: 'vitest run'}}));
    await fs.writeFile(path.join(f.checkout, 'scripts/workspace/check.mjs'), `import fs from 'node:fs';
        fs.appendFileSync(process.env.DEV_CLI_RECORD, JSON.stringify({kind:'check',args:process.argv.slice(2),dotenv:process.env.DEV_DOTENV_MARKER??null})+'\\n');
        process.exitCode=7;`);
    await fs.writeFile(path.join(f.checkout, '.env'), 'DEV_DOTENV_MARKER=unexpected\n');
    const result = await f.run('check', '--package', 'frontend', '--step', 'test');
    assert.equal(result.status, 7, result.stdout+result.stderr);
    assert.deepEqual(result.events, [{kind: 'check', args: ['--package', 'frontend', '--step', 'test'], dotenv: null}]);
    assert.doesNotMatch(result.stdout, /Проверки проекта завершены/);
    await assert.rejects(fs.access(path.join(f.checkout, '.run')), {code: 'ENOENT'});
});

test('check --help показывает свои селекторы без dotenv, npm и файлов отчёта', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.checkout, '.env'), 'malformed dotenv is not needed for help');
    const result = await f.run('check', '--help');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--package/); assert.match(result.stdout, /--step/);
    assert.deepEqual(result.events, []);
    await assert.rejects(fs.access(path.join(f.checkout, '.run')), {code: 'ENOENT'});
});

test('check сохраняет SIGTERM дочерней проверки как код 143', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.checkout, 'frontend/package.json'), JSON.stringify({scripts: {test: 'vitest run'}}));
    await fs.writeFile(path.join(f.checkout, 'scripts/workspace/check.mjs'), `process.kill(process.pid,'SIGTERM');`);
    const result = await f.run('check', '--package', 'frontend', '--step', 'test');
    assert.equal(result.status, 143, result.stdout+result.stderr);
    assert.deepEqual(result.events, []);
});

test('отмена только dev check завершает его потомков и сохраняет чужой процесс', async t => {
    if (process.platform === 'win32') { t.skip('POSIX owned process groups.'); return; }
    const f = await fixture(t);
    await fs.writeFile(path.join(f.checkout, 'frontend/package.json'), JSON.stringify({scripts: {test: 'vitest run'}}));
    await fs.writeFile(path.join(f.checkout, 'scripts/workspace/check.mjs'), `import {spawn} from 'node:child_process';
        const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},50)"],{stdio:'ignore'});
        process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100));console.log(JSON.stringify({pid:process.pid,child:child.pid}));setInterval(()=>{},50);`);
    const outsider = spawn(process.execPath, ['-e', 'setInterval(()=>{},50)'], {stdio: 'ignore', detached: true});
    const launcher = spawn(process.execPath, [path.join(f.checkout, 'scripts/dev.mjs'), 'check', '--package', 'frontend', '--step', 'test'],
        {cwd: f.checkout, env: f.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    let output = '', errors = '', owned;
    launcher.stdout.on('data', bytes => { output += bytes; if (output.includes('\n')) owned = JSON.parse(output.trim()); });
    launcher.stderr.on('data', bytes => { errors += bytes; });
    const ended = new Promise(resolve => launcher.once('close', (code, signal) => resolve({code, signal})));
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    t.after(async () => {
        for (const pid of [launcher.pid, owned?.pid, outsider.pid]) if (pid) try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await ended;
    });
    for (let attempt = 0; attempt < 200 && !owned; attempt++) await delay(25);
    assert.ok(owned, errors || 'check did not start');
    launcher.kill('SIGTERM');
    const result = await Promise.race([ended, delay(5000).then(() => null)]);
    assert.deepEqual(result, {code: 143, signal: null});
    for (let attempt = 0; attempt < 100 && (alive(owned.pid) || alive(owned.child)); attempt++) await delay(25);
    assert.equal(alive(owned.pid), false); assert.equal(alive(owned.child), false); assert.equal(alive(outsider.pid), true);
});

for(const args of [['up','--profile'],['up','--profile='],['up','--profile','unknown'],['up','--profile=fast','--profile','full'],
    ['up','--profile','fast','extra'],['build','--profile','unknown'],['status','--profile=full']]) {
    test(`Некорректный профиль ${args.join(' ')} отклоняется до побочных действий`,async t=>{
        const f=await fixture(t),result=await f.run(...args);
        assert.equal(result.status,1);assert.match(result.stderr,/Неизвестная команда или параметры/);
        assert.deepEqual(result.events,[]);await assert.rejects(fs.access(path.join(f.checkout,'.run')),{code:'ENOENT'});
    });
}

test('Статус показывает адреса всех сервисов и не меняет состояние процессов', async t => {
    const f = await fixture(t), result = await f.run('status');
    assert.equal(result.status, 0, result.stderr);
    for (const port of [22222, 4100, 4200, 4300, 4400, 4000, 5173]) assert.ok(result.stdout.includes(String(port)), String(port));
    assert.match(result.stdout, /готов/);
    assert.match(result.stderr,/остальные проверки не пройдены или пропущены/);
    assert.doesNotMatch(result.stdout,/Все сервисы готовы/);
    assert.match(result.stdout,/checkout: неизвестен/);
    const requests = result.events.filter(event => event.kind === 'health');
    assert.deepEqual(requests.map(event => event.port).sort(), ['22222','22222','4000','4100','4100','4200','4300','4300','4400','4400','5173']);
    assert.deepEqual(requests.find(event => event.port === '5173'), {
        kind: 'health', port: '5173', path: '/node_modules/antd/dist/antd.less', search: '?direct',
    });
    assert.deepEqual(requests.filter(event=>event.path==='/ready').map(event=>event.port).sort(),['22222','4100','4300','4400']);
    assert.equal(requests.find(event=>event.port==='4400'&&event.path==='/health').path,'/health');
    assert.equal(await fs.readFile(path.join(f.checkout,'.run/project-snapshots/secrets/verifier-token'),'utf8'),'a'.repeat(64)+'\n');
    await assert.rejects(fs.access(path.join(f.checkout, '.run/processes.json')), {code: 'ENOENT'});
});

for (const [mode, description] of [
    ['frontend-error', 'ошибку компиляции Less'],
    ['frontend-html', 'HTML с кодом 200 вместо CSS'],
    ['frontend-empty', 'пустой CSS'],
]) {
    test('Статус отклоняет ' + description + ', даже когда все серверные сервисы готовы', async t => {
        const f = await fixture(t, mode), result = await f.run('status');
        assert.equal(result.status, 1);
        assert.match(result.stdout, /Веб-интерфейс[^\n]*компиляция: не готова/);
        for (const label of ['Вход и сессии', 'Каталог', 'Флаги функций', 'Скиллы', 'Базы знаний', 'API']) {
            assert.match(result.stdout, new RegExp(label + '[^\\n]*процесс: отвечает'));
        }
        assert.match(result.stderr, /Подтверждена готовность сервисов: 0\/7/);
        await assert.rejects(fs.access(path.join(f.checkout, '.run/processes.json')), {code: 'ENOENT'});
    });
}

test('Недоступный сервис остаётся заметен и сохраняет ненулевой код status', async t => {
    const f = await fixture(t, 'unavailable'), result = await f.run('status');
    assert.equal(result.status, 1);
    assert.match(result.stdout, /4300/);
    assert.match(result.stdout, /процесс: не отвечает/);
    assert.equal(result.events.filter(event => event.kind === 'health').length, 11);
});

test('status reports failed dependencies despite health 200 and does not claim full readiness',async t=>{
    const f=await fixture(t,'dependency-failed'),result=await f.run('status');
    assert.equal(result.status,1);assert.match(result.stdout,/Каталог[^\n]*процесс: отвечает; зависимости: не готовы/);
    assert.doesNotMatch(result.stdout,/Все сервисы готовы/);
    assert.equal(result.events.filter(event=>event.kind==='health'&&event.port==='4100'&&event.path==='/ready').length,1);
});

test('status with details disabled keeps legacy probes and labels readiness unknown',async t=>{
    const f=await fixture(t);f.env.NEUROCENTER_DEV_MCP_SERVICE_DETAILS='0';const result=await f.run('status');
    assert.equal(result.status,0);assert.match(result.stdout,/готовность: проверка отключена/);
    assert.match(result.stdout,/checkout: проверка отключена/);assert.doesNotMatch(result.stdout,/Все сервисы готовы/);
    assert.equal(result.events.filter(event=>event.kind==='health').length,7);
    assert.equal(result.events.filter(event=>event.kind==='health'&&event.path==='/ready').length,0);
});

test('up rejects an invalid service details flag before builds and process changes',async t=>{
    const f=await fixture(t);f.env.NEUROCENTER_DEV_MCP_SERVICE_DETAILS='yes';const result=await f.run('up');
    assert.equal(result.status,1);assert.match(result.stderr,/NEUROCENTER_DEV_MCP_SERVICE_DETAILS must be 0 or 1/);
    assert.deepEqual(result.events,[]);await assert.rejects(fs.access(path.join(f.checkout,'.run')),{code:'ENOENT'});
});

test('Логи читаются из LOGDIR с пробелами и показывают последние события', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.logs, 'neurocenter-gateway.log'), Array.from({length: 30}, (_, i) => `gateway event ${i + 1}`).join('\n'));
    const result = await f.run('tail');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /gateway event 30/);
    assert.doesNotMatch(result.stdout, /gateway event 1\n/);
    assert.deepEqual(result.events, []);
});

test('Пустые логи объясняются пользователю без ложной ошибки запуска', async t => {
    const f = await fixture(t), result = await f.run('tail');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /лог/iu);
    assert.match(result.stdout, /нет|пока|не найд|отсутств/iu);
    assert.deepEqual(result.events, []);
});

for (const failed of [true, false]) {
    test(`install ${failed ? 'сохраняет прежнюю поставку при отказе' : 'публикует мост после готовности'} проверщика снимков`, async t => {
        const f = await fixture(t), pointer = path.join(f.checkout, '.run/dev-bridge/runtime/current.json');
        await fs.mkdir(path.dirname(pointer), {recursive: true});
        await fs.writeFile(pointer, 'previous-release\n');
        const npm = f.env.NPM_CLI_JS;
        await fs.writeFile(npm, (await fs.readFile(npm, 'utf8')).replace('process.exitCode=7;', 'process.exitCode=0;'));
        const record = `import {appendFileSync} from 'node:fs';
            const record=kind=>appendFileSync(process.env.DEV_CLI_RECORD,JSON.stringify({kind})+'\\n');`;
        await fs.writeFile(path.join(f.checkout, 'scripts/workspace/compose.mjs'), `${record}
            export async function ensureCompose(){record('compose-ready');} export function checkCompose(){throw Error('UNEXPECTED_START');}`);
        await fs.writeFile(path.join(f.checkout, 'scripts/workspace/dev-snapshots.mjs'), `${record}
            export async function buildDevSnapshotImage(){record('snapshot-build');${failed ? "throw Error('FIXTURE_SNAPSHOT_BUILD_FAILED');" : ''}}
            export function inspectDevSnapshotImage(){throw Error('UNEXPECTED_START');} export function prepareDevSnapshots(){throw Error('UNEXPECTED_START');}`);
        await fs.writeFile(path.join(f.checkout, 'scripts/workspace/dev-bridge-runtime.mjs'), `${record}
            import {writeFileSync} from 'node:fs';
            export async function prepareDevBridge(){record('bridge-publish');writeFileSync(${JSON.stringify(pointer)},'accepted-release\\n');}`);
        const result = await f.run('install', '--profile', 'standard');
        assert.equal(result.status, failed ? 1 : 0, result.stdout + result.stderr);
        assert.deepEqual(result.events.filter(event => ['snapshot-build', 'bridge-publish'].includes(event.kind)).map(event => event.kind),
            failed ? ['snapshot-build'] : ['snapshot-build', 'bridge-publish']);
        assert.equal(await fs.readFile(pointer, 'utf8'), failed ? 'previous-release\n' : 'accepted-release\n');
        if (failed) { assert.match(result.stderr, /FIXTURE_SNAPSHOT_BUILD_FAILED/); assert.doesNotMatch(result.stdout, /Зависимости установлены/); }
        else { assert.match(result.stdout, /Зависимости установлены/); }
    });
}

for (const command of ['install', 'build']) for (const tty of [false, true]) {
    test(`${command} fast preserves existing bridge and keys without Native or verifier preparation (${tty ? 'TTY' : 'headless'})`, async t => {
        const f = await fixture(t), pointer = path.join(f.checkout, '.run/dev-bridge/runtime/current.json');
        const signing = path.join(f.checkout, '.run/project-snapshots/secrets/signing.pem');
        for (const [file, bytes] of [[pointer, 'previous-supply\n'], [signing, 'preserve-existing-identity\n']]) {
            await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, bytes, {mode: 0o600});
        }
        await fs.rm(path.join(f.checkout, 'mcp'), {recursive: true});
        await fs.writeFile(f.env.NPM_CLI_JS, (await fs.readFile(f.env.NPM_CLI_JS, 'utf8')).replace('process.exitCode=7;', 'process.exitCode=0;'));
        await fs.writeFile(path.join(f.checkout, 'scripts/workspace/compose.mjs'), 'export async function ensureCompose(){} export function checkCompose(){}');
        f.env.DEV_CLI_TTY = tty ? '1' : '0';
        const result = await f.run(command);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(result.events.filter(event => event.kind === 'npm').length, 8);
        assert.equal(result.events.some(event => event.cwd?.includes('neurocenter-asset-sync')), false);
        assert.equal(await fs.readFile(pointer, 'utf8'), 'previous-supply\n');
        assert.equal(await fs.readFile(signing, 'utf8'), 'preserve-existing-identity\n');
        assert.match(result.stdout, /fast/);
    });
}

/** Exercise the full CLI startup while all OS, service and storage effects stay inside this checkout. */
async function coreStartupFixture(t,tty){
    const f=await fixture(t);f.env.DEV_CLI_TTY=tty?'1':'0';f.env.DEV_CLI_CORE_STARTUP='1';f.env.DEV_BRIDGE_RUNTIME_DIR=path.join(f.checkout,'.run/dev-bridge/runtime');
    await fs.rm(path.join(f.checkout,'mcp'),{recursive:true});
    await fs.writeFile(f.env.NPM_CLI_JS,(await fs.readFile(f.env.NPM_CLI_JS,'utf8')).replace('process.exitCode=7;','process.exitCode=0;'));
    const record=`import {appendFileSync} from 'node:fs';const record=(kind,extra={})=>appendFileSync(process.env.DEV_CLI_RECORD,JSON.stringify({kind,...extra})+'\\n');`;
    const child=`const child=()=>({exitCode:null,signalCode:null,unref(){}});`;
    const modules={
        'compose.mjs':`${record} export async function ensureCompose(){} export function checkCompose(){record('compose-ready');}`,
        'dev-processes.mjs':`export function devServiceEntry(root,service){return root+'/'+service.dir+'/dist/main.js';} export const discoverDevProcesses=()=>[];export const ownsDevProcess=()=>false;`,
        'dev-launch-provenance.mjs':`${record}${child}let pid=42000;export async function launchDevService({service,environment}){record('service-launch',{name:service.name,snapshotExecutor:environment.SNAPSHOT_EXECUTOR_ENABLED??null,devBridgeOverride:environment.DEV_BRIDGE_RUNTIME_DIR??null,assetSyncMcpBin:environment.ASSET_SYNC_MCP_BIN??null});return {child:child(),record:{name:service.name,pid:++pid},logFile:'fixture.log'};}export async function currentDevLaunchId(){}`,
        'dev-launch-recovery.mjs':`export async function recoverDevLaunch(){throw Error('UNEXPECTED_RECOVERY');}`,
        'dev-watch-control.mjs':`${record}${child}export async function startDevWatch({services}){for(const service of services)record('service-launch',{name:service.name,snapshotExecutor:service.environment.SNAPSHOT_EXECUTOR_ENABLED??null,devBridgeOverride:service.environment.DEV_BRIDGE_RUNTIME_DIR??null,assetSyncMcpBin:service.environment.ASSET_SYNC_MCP_BIN??null});return {child:child(),record:{name:'source-watch',pid:42010}};}export async function stopDevWatch(){} export async function devWatchStatus(){}`,
        'dev-service-health.mjs':`${record}export const devServices=${JSON.stringify(devServices)};export const serviceDetailsFlag=()=>true;export const devServiceHealth=services=>async()=>services.map(service=>({service:service.name,ready:true,liveness:{ok:true},compilation:{ok:true},readiness:{state:'http-ok',ok:true},ownership:{state:'owned'}}));export async function probeLocalEndpoint(){throw Error('UNEXPECTED_VERIFIER_PROBE');}`,
        'dev-model-credentials.mjs':`export async function prepareDevModelCredentials(){return {};}`,
        'dev-chat-storage.mjs':`export async function prepareDevChatStorage(){return {};}`,
        'dev-bridge-startup.mjs':`${record}export async function applyPublishedDevBridge(){record('bridge-apply');throw Error('UNEXPECTED_BRIDGE_APPLY');}`,
    };
    for(const [file,source]of Object.entries(modules))await fs.writeFile(path.join(f.checkout,'scripts/workspace',file),source);
    await fs.writeFile(path.join(f.checkout,'scripts/assets/selection.mjs'),`${record}export async function selectStartupAssets(){record('asset-selection');throw Error('UNEXPECTED_ASSET_SELECTION');}`);
    const docker=path.join(path.dirname(f.env.NPM_CLI_JS),'bin/docker');
    await fs.writeFile(docker,`#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.DEV_CLI_RECORD,JSON.stringify({kind:'docker',args})+'\\n');
        if(JSON.stringify(args)===JSON.stringify(['compose','up','-d','--wait','--wait-timeout','45','postgres']))process.exitCode=0;
        else if(JSON.stringify(args)===JSON.stringify(['compose','ps','-q','postgres']))process.stdout.write('owned-fixture-postgres\\n');
        else process.exitCode=92;`,{mode:0o700});
    return f;
}

for(const command of ['up','watch'])for(const tty of [false,true])test(`${command} fast reaches core readiness without assets, Native or snapshot executor (${tty?'TTY':'headless'})`,async t=>{
    const f=await coreStartupFixture(t,tty),result=await f.run(command);
    assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/Готов к работе/);assert.match(result.stdout,/новые публикации недоступны/);
    assert.deepEqual(result.events.filter(event=>event.kind==='service-launch').map(event=>event.name),devServices.map(service=>service.name));
    assert.equal(result.events.find(event=>event.kind==='service-launch'&&event.name==='catalog').snapshotExecutor,'0');
    assert.equal(result.events.find(event=>event.kind==='service-launch'&&event.name==='gateway').devBridgeOverride,null);
    assert.equal(result.events.some(event=>['asset-selection','bridge-apply'].includes(event.kind)),false);
    assert.equal(result.events.filter(event=>event.kind==='docker').length,2);assert.equal(result.events.filter(event=>event.kind==='npm').length,7);
    await assert.rejects(fs.stat(path.join(f.checkout,'.run/project-snapshots/secrets')),{code:'ENOENT'});
});

for(const command of ['up','watch'])for(const manual of [false,true])test(`${command} fast preserves ${manual?'the manual MCP path':'an unset MCP path'} without a Native checkout`,async t=>{
    const f=await coreStartupFixture(t,false),manualPath=path.join(f.checkout,'manual bridge','index.js');
    if(manual)f.env.ASSET_SYNC_MCP_BIN=manualPath;
    const result=await f.run(command);assert.equal(result.status,0,result.stdout+result.stderr);
    const launched=result.events.filter(event=>event.kind==='service-launch');assert.equal(launched.length,devServices.length);
    for(const service of launched)assert.equal(service.assetSyncMcpBin,manual?manualPath:null,service.name);
    await assert.rejects(fs.stat(path.join(f.checkout,'mcp')),{code:'ENOENT'});
});

for(const profile of ['standard','full'])for(const command of ['up','watch'])test(`${command} extended startup excludes model weights even with an old saved model selection (${profile})`,async t=>{
    const f=await fixture(t),selection=path.join(f.checkout,'.run/assets-selection.json');await fs.mkdir(path.dirname(selection));
    const previous=JSON.stringify({selected:['old-model','old-tool'],withoutModels:false});await fs.writeFile(selection,previous);
    await fs.writeFile(path.join(f.checkout,'scripts/workspace/compose.mjs'),'export function checkCompose(){} export async function ensureCompose(){}');
    await fs.writeFile(path.join(f.checkout,'scripts/workspace/dev-snapshots.mjs'),"export function inspectDevSnapshotImage(){return 'sha256:'+'a'.repeat(64);} export function buildDevSnapshotImage(){} export function prepareDevSnapshots(){throw Error('UNEXPECTED_SNAPSHOT_PREPARATION');}");
    await fs.writeFile(path.join(f.checkout,'scripts/assets/startup.mjs'),`import {appendFileSync,readFileSync} from 'node:fs';
        export async function prepareStartupAssets(options){appendFileSync(process.env.DEV_CLI_RECORD,JSON.stringify({kind:'startup-assets',withoutModels:options.withoutModels,savedSelection:JSON.parse(readFileSync(${JSON.stringify(selection)},'utf8')).selected})+'\\n');throw Error('STOP_AFTER_ASSET_ADMISSION');}`);
    const result=await f.run(command,'--profile',profile);assert.equal(result.status,1);assert.match(result.stderr,/STOP_AFTER_ASSET_ADMISSION/);
    assert.deepEqual(result.events.filter(event=>event.kind==='startup-assets'),[{kind:'startup-assets',withoutModels:true,savedSelection:['old-model','old-tool']}]);
    assert.equal(await fs.readFile(selection,'utf8'),previous);
});

test('full starts prepared hosting without requesting model installation or activation',async t=>{
    const f=await coreStartupFixture(t,false);await fs.mkdir(path.join(f.checkout,'mcp/neurocenter-asset-sync'),{recursive:true});
    f.env.ASSET_SYNC_MCP_BIN=path.join(f.checkout,'manual bridge','index.js');
    const record=`import {appendFileSync} from 'node:fs';const record=(kind,extra={})=>appendFileSync(process.env.DEV_CLI_RECORD,JSON.stringify({kind,...extra})+'\\n');`;
    const token=path.join(f.checkout,'.run/project-snapshots/secrets/verifier-token');await fs.mkdir(path.dirname(token),{recursive:true});await fs.writeFile(token,'a'.repeat(64)+'\n',{mode:0o600});
    await fs.writeFile(path.join(f.checkout,'scripts/workspace/dev-snapshots.mjs'),"export function inspectDevSnapshotImage(){return 'sha256:'+'a'.repeat(64);} export function buildDevSnapshotImage(){} export function prepareDevSnapshots(){return {catalog:{SNAPSHOT_EXECUTOR_ENABLED:'1'},runner:{}};}");
    await fs.writeFile(path.join(f.checkout,'scripts/assets/startup.mjs'),`${record}export async function prepareStartupAssets(options){record('startup-assets',{withoutModels:options.withoutModels});return {ok:true};}`);
    await fs.writeFile(path.join(f.checkout,'scripts/models/startup.mjs'),`${record}export function modelRuntimeEnvironment(){return {};}export async function startModelRuntime(options){record('hosting-start',{preparedOnly:options.preparedOnly});return {ok:true};}`);
    const health=path.join(f.checkout,'scripts/workspace/dev-service-health.mjs');await fs.writeFile(health,(await fs.readFile(health,'utf8')).replace("throw Error('UNEXPECTED_VERIFIER_PROBE');","return {ok:true};"));
    const result=await f.run('up','--profile','full');assert.equal(result.status,0,result.stdout+result.stderr);
    assert.deepEqual(result.events.filter(event=>event.kind==='startup-assets'),[{kind:'startup-assets',withoutModels:true}]);
    assert.deepEqual(result.events.filter(event=>event.kind==='hosting-start'),[{kind:'hosting-start',preparedOnly:true}]);
    for(const service of result.events.filter(event=>event.kind==='service-launch'&&event.name!=='snapshot-verifier'))assert.equal(service.assetSyncMcpBin,path.join(f.checkout,'mcp/neurocenter-asset-sync/dist/index.js'));
});

test('Ошибка сборки видна в stderr и не подменяется сообщением об успехе', async t => {
    const f = await fixture(t), result = await f.run('build');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /код\S*\s+7/);
    // Отказ корневой зависимости останавливает сборку до обращения к пакетам сервисов.
    const installs=result.events.filter(event=>event.kind==='npm');
    assert.equal(installs.length,1);
    assert.deepEqual(installs[0].args.slice(0,4),['ci','--ignore-scripts','--no-audit','--no-fund']);
    assert.ok(installs[0].args.includes('--registry=https://registry.npmjs.org/'));
    assert.ok(installs[0].args.includes('--strict-ssl=false'));
    assert.ok(installs[0].args.some(arg=>arg.startsWith('--userconfig=')));
    assert.ok(installs[0].args.some(arg=>arg.startsWith('--globalconfig=')));
    assert.doesNotMatch(result.stdout, /Нейроцентр готов|Сборка завершена/);
});

test('Dev build dependency install ignores hostile global/user config and removes its temporary HOME after failure',async t=>{
    const f=await fixture(t),home=path.join(f.checkout,'host-home'),globalconfig=path.join(f.checkout,'host-global.npmrc');
    await fs.mkdir(home);const hostile='registry=http://127.0.0.1:9/\n@fixture:registry=http://127.0.0.1:9/\nstrict-ssl=true\n';
    await fs.writeFile(path.join(home,'.npmrc'),hostile);await fs.writeFile(globalconfig,hostile);
    Object.assign(f.env,{HOME:home,NPM_CONFIG_GLOBALCONFIG:globalconfig,npm_config_registry:'http://127.0.0.1:9/',NPM_CONFIG_OFFLINE:'true',NPM_TOKEN:'synthetic',NODE_AUTH_TOKEN:'synthetic'});
    const result=await f.run('build'),call=result.events.find(event=>event.kind==='npm');
    assert.equal(result.status,1);assert.deepEqual(call.configKeys.sort(),['NPM_CONFIG_STRICT_SSL','npm_config_strict_ssl'].sort());assert.equal(call.hasToken,false);assert.notEqual(call.home,home);
    assert.ok(call.args.includes('--registry=https://registry.npmjs.org/'));assert.ok(call.args.includes('--strict-ssl=false'));
    await assert.rejects(fs.stat(call.home),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(home,'.npmrc'),'utf8'),hostile);assert.equal(await fs.readFile(globalconfig,'utf8'),hostile);
});
