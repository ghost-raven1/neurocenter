import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
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
    for (const file of ['dev.sh', 'dev.mjs', 'workspace/node-runtime.mjs', 'workspace/compose.mjs',
        'workspace/compose.lock.json', 'workspace/dev-output.mjs', 'workspace/dev-processes.mjs']) {
        await fs.copyFile(path.join(root, 'scripts', file), path.join(checkout, 'scripts', file));
    }
    for(const directory of ['models','embedding','vision'])await fs.cp(path.join(root,'scripts',directory),path.join(checkout,'scripts',directory),{recursive:true});
    await fs.copyFile(path.join(root,'scripts/workspace/catalog-startup.mjs'),path.join(checkout,'scripts/workspace/catalog-startup.mjs'));
    for (const packageDirectory of workspacePackages) await fs.mkdir(path.join(checkout, packageDirectory), {recursive: true});
    const npm = path.join(directory, 'npm-cli.js');
    await fs.writeFile(npm, `require('node:fs').appendFileSync(process.env.DEV_CLI_RECORD,JSON.stringify({kind:'npm',args:process.argv.slice(2)})+'\\n');
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
        const result = spawnSync('/bin/bash', [path.join(checkout, 'scripts/dev.sh'), ...args], {
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
    return {checkout, logs, run};
}

for (const args of [[], ['--help'], ['help'], ['-h'], ['down', '--help']]) {
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

test('Статус показывает адреса всех сервисов и не меняет состояние процессов', async t => {
    const f = await fixture(t), result = await f.run('status');
    assert.equal(result.status, 0, result.stderr);
    for (const port of [22222, 4100, 4200, 4300, 4400, 4000, 5173]) assert.ok(result.stdout.includes(String(port)), String(port));
    assert.match(result.stdout, /готов/);
    assert.equal(result.stderr, '');
    const requests = result.events.filter(event => event.kind === 'health');
    assert.deepEqual(requests.map(event => event.port).sort(), ['22222', '4000', '4100', '4200', '4300', '4400', '5173']);
    assert.deepEqual(requests.find(event => event.port === '5173'), {
        kind: 'health', port: '5173', path: '/node_modules/antd/dist/antd.less', search: '?direct',
    });
    assert.ok(requests.filter(event => !['5173','4400'].includes(event.port)).every(event => event.path === '/health' && event.search === ''));
    assert.equal(requests.find(event=>event.port==='4400').path,'/ready');
    assert.deepEqual(result.events.filter(event => event.kind === 'timeout').map(event => event.ms).sort((a, b) => a - b),
        [1000, 1000, 1000, 1000, 1000, 1000, 10000]);
    await assert.rejects(fs.access(path.join(f.checkout, '.run')), {code: 'ENOENT'});
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
        assert.match(result.stderr, /Готово сервисов: 6\/7/);
        await assert.rejects(fs.access(path.join(f.checkout, '.run')), {code: 'ENOENT'});
    });
}

test('Недоступный сервис остаётся заметен и сохраняет ненулевой код status', async t => {
    const f = await fixture(t, 'unavailable'), result = await f.run('status');
    assert.equal(result.status, 1);
    assert.match(result.stdout, /4300/);
    assert.match(result.stdout, /недоступ/);
    assert.equal(result.events.filter(event => event.kind === 'health').length, 7);
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
    assert.equal(result.events.filter(event => event.kind === 'npm').length, 1);
    assert.doesNotMatch(result.stdout, /Нейроцентр готов|Сборка завершена/);
});
