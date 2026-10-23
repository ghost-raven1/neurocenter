import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {workspacePackages} from '../workspace/check-plan.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const commands = ['install', 'build', 'check', 'up', 'down', 'status', 'tail'];

/** CLI работает с собственным checkout, логами и ответами health без доступа к живому стеку. */
async function fixture(t, mode = 'ready') {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter dev cli ')));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const checkout = path.join(directory, 'checkout'), logs = path.join(directory, 'логи сервисов'), bin = path.join(directory, 'bin');
    const record = path.join(directory, 'calls.jsonl');
    await fs.mkdir(path.join(checkout, 'scripts/workspace'), {recursive: true});
    await fs.mkdir(logs);
    await fs.mkdir(bin);
    for (const command of ['docker', 'ps']) {
        await fs.writeFile(path.join(bin, command), `#!${process.execPath}
            require('node:fs').appendFileSync(process.env.DEV_CLI_RECORD,JSON.stringify({kind:'unexpected-command',command:${JSON.stringify(command)}})+'\\n');
            process.exitCode=92;`, {mode: 0o700});
    }
    for (const file of ['dev.sh', 'dev.mjs', 'workspace/node-runtime.mjs', 'workspace/npm-build-environment.mjs', 'workspace/dev-chat-storage.mjs', 'workspace/model-credentials.mjs', 'workspace/model-credential-store.mjs', 'workspace/dev-model-credentials.mjs', 'workspace/dev-snapshots.mjs', 'workspace/docker-build-ca.mjs', 'workspace/compose.mjs',
        'workspace/compose.lock.json', 'workspace/dev-output.mjs', 'workspace/dev-processes.mjs', 'workspace/check-plan.mjs', 'workspace/node24-cli.mjs']) {
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
        configKeys:Object.keys(process.env).filter(key=>/^npm_config_/i.test(key)),hasToken:!!(process.env.NPM_TOKEN||process.env.NODE_AUTH_TOKEN)})+'\\n');
        process.exitCode=7;`);
    const hook = path.join(directory, 'isolated-network.mjs');
    await fs.writeFile(hook, `import {appendFileSync} from 'node:fs';
        import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
        import {syncBuiltinESMExports} from 'node:module';
        const record=value=>appendFileSync(process.env.DEV_CLI_RECORD,JSON.stringify(value)+'\\n');
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
            const ok=process.env.DEV_CLI_MODE!=='unavailable'||url.port!=='4300';
            return new Response(JSON.stringify({ok}),{status:ok?200:503,headers:{'Content-Type':'application/json'}});
        };
        http.request=http.get=https.request=https.get=net.connect=net.createConnection=deny; syncBuiltinESMExports();`);
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
    ['up','--profile','fast','extra'],['build','--profile','fast'],['status','--profile=full']]) {
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
    assert.equal(result.stderr, '');
    const requests = result.events.filter(event => event.kind === 'health');
    assert.deepEqual(requests.map(event => event.port).sort(), ['22222', '4000', '4100', '4100', '4200', '4300', '4400', '5173']);
    assert.deepEqual(requests.find(event => event.port === '5173'), {
        kind: 'health', port: '5173', path: '/node_modules/antd/dist/antd.less', search: '?direct',
    });
    assert.ok(requests.filter(event => !['5173','4400'].includes(event.port)&&event.path!=='/internal/project-snapshots/verifier/ready').every(event => event.path === '/health' && event.search === ''));
    assert.equal(requests.find(event=>event.port==='4400').path,'/ready');
    assert.deepEqual(result.events.filter(event => event.kind === 'timeout').map(event => event.ms).sort((a, b) => a - b),
        [1000, 1000, 1000, 1000, 1000, 1000, 1000, 10000]);
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
        assert.match(result.stdout, /Веб-интерфейс[^\n]*недоступен/);
        for (const label of ['Вход и сессии', 'Каталог', 'Флаги функций', 'Скиллы', 'Базы знаний', 'API']) {
            assert.match(result.stdout, new RegExp(label + '[^\\n]*готов'));
        }
        assert.match(result.stderr, /Готово сервисов: 7\/8/);
        await assert.rejects(fs.access(path.join(f.checkout, '.run/processes.json')), {code: 'ENOENT'});
    });
}

test('Недоступный сервис остаётся заметен и сохраняет ненулевой код status', async t => {
    const f = await fixture(t, 'unavailable'), result = await f.run('status');
    assert.equal(result.status, 1);
    assert.match(result.stdout, /4300/);
    assert.match(result.stdout, /недоступ/);
    assert.equal(result.events.filter(event => event.kind === 'health').length, 8);
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

test('Ошибка сборки видна в stderr и не подменяется сообщением об успехе', async t => {
    const f = await fixture(t), result = await f.run('build');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /код\S*\s+7/);
    // Отказ корневой зависимости останавливает сборку до обращения к пакетам сервисов.
    const installs=result.events.filter(event=>event.kind==='npm');
    assert.equal(installs.length,1);
    assert.deepEqual(installs[0].args.slice(0,4),['ci','--ignore-scripts','--no-audit','--no-fund']);
    assert.ok(installs[0].args.includes('--registry=https://registry.npmjs.org/'));
    assert.ok(installs[0].args.includes('--strict-ssl=true'));
    assert.ok(installs[0].args.some(arg=>arg.startsWith('--userconfig=')));
    assert.ok(installs[0].args.some(arg=>arg.startsWith('--globalconfig=')));
    assert.doesNotMatch(result.stdout, /Нейроцентр готов|Сборка завершена/);
});

test('Dev build dependency install ignores hostile global/user config and removes its temporary HOME after failure',async t=>{
    const f=await fixture(t),home=path.join(f.checkout,'host-home'),globalconfig=path.join(f.checkout,'host-global.npmrc');
    await fs.mkdir(home);const hostile='registry=http://127.0.0.1:9/\n@fixture:registry=http://127.0.0.1:9/\nstrict-ssl=false\n';
    await fs.writeFile(path.join(home,'.npmrc'),hostile);await fs.writeFile(globalconfig,hostile);
    Object.assign(f.env,{HOME:home,NPM_CONFIG_GLOBALCONFIG:globalconfig,npm_config_registry:'http://127.0.0.1:9/',NPM_CONFIG_OFFLINE:'true',NPM_TOKEN:'synthetic',NODE_AUTH_TOKEN:'synthetic'});
    const result=await f.run('build'),call=result.events.find(event=>event.kind==='npm');
    assert.equal(result.status,1);assert.deepEqual(call.configKeys,[]);assert.equal(call.hasToken,false);assert.notEqual(call.home,home);
    assert.ok(call.args.includes('--registry=https://registry.npmjs.org/'));assert.ok(call.args.includes('--strict-ssl=true'));
    await assert.rejects(fs.stat(call.home),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(home,'.npmrc'),'utf8'),hostile);assert.equal(await fs.readFile(globalconfig,'utf8'),hostile);
});
