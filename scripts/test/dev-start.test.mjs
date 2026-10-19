import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const services = [
    ['bridge', 'services/oauth2-bridge'],
    ['catalog', 'services/catalog-service'],
    ['flags', 'services/feature-flags-service'],
    ['skills', 'services/skills-service'],
    ['rag', 'services/rag-sync-service'],
    ['gateway', 'services/api-gateway'],
    ['frontend', 'frontend'],
];

async function eventsFrom(filename) {
    try { return (await fs.readFile(filename, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/** Настоящий CLI запускает только тестовые процессы; Docker, npm и сеть заменены в его окружении. */
async function fixture(t, mode) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter dev start ')));
    const checkout = path.join(directory, 'checkout'), bin = path.join(directory, 'bin');
    const calls = path.join(directory, 'calls.jsonl'), marker = path.join(directory, 'health-started');
    let cli;
    t.after(async () => {
        if (cli?.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
        // Путь entry из fixture проверяется повторно: переиспользованный PID не получает сигнал.
        const children = (await eventsFrom(calls)).filter(event => ['child-spawn','model-child-spawn','model-runtime-wait'].includes(event.kind));
        for (const child of children) {
            const command = spawnSync('ps', ['-ww', '-p', String(child.pid), '-o', 'command='], {encoding: 'utf8'});
            if (command.status !== 0 || !command.stdout.includes(child.entry) || !child.entry.startsWith(directory + path.sep)) continue;
            try { process.kill(child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        await fs.rm(directory, {recursive: true, force: true});
    });
    await fs.mkdir(path.join(checkout, 'scripts/workspace'), {recursive: true});
    await fs.mkdir(bin);
    for (const file of ['dev.mjs', 'workspace/dev-processes.mjs', 'workspace/node-runtime.mjs',
        'workspace/compose.mjs', 'workspace/compose.lock.json', 'workspace/dev-output.mjs', 'workspace/catalog-startup.mjs']) {
        await fs.copyFile(path.join(root, 'scripts', file), path.join(checkout, 'scripts', file));
    }
    for(const directory of ['models','embedding','vision'])await fs.cp(path.join(root,'scripts',directory),path.join(checkout,'scripts',directory),{recursive:true});
    await fs.mkdir(path.join(checkout,'scripts/assets'));
    await fs.copyFile(path.join(root,'scripts/release-request.mjs'),path.join(checkout,'scripts/release-request.mjs'));
    await fs.copyFile(path.join(root,'scripts/assets/startup.mjs'),path.join(checkout,'scripts/assets/startup.mjs'));
    await fs.writeFile(path.join(checkout,'scripts/assets/cli.mjs'), `
        import {appendFileSync} from 'node:fs';
        appendFileSync(process.env.DEV_START_CALLS,JSON.stringify({kind:'assets-sync'})+'\\n');
        if(process.env.DEV_START_MODE==='assets-error'){console.error('fixture assets failed');process.exit(37);}
        console.log(JSON.stringify({ok:true,mode:'prefetch',verifyOnly:false,revision:'a'.repeat(64)}));`);
    await fs.writeFile(path.join(checkout,'scripts/models/bundle-cli.mjs'), `
        import {appendFileSync,rmSync} from 'node:fs';
        if(process.argv.includes('--recover-only')){
            appendFileSync(process.env.DEV_START_CALLS,JSON.stringify({kind:'model-recovery'})+'\\n');
            if(process.env.DEV_START_MODE==='assets-recover-error')process.exit(38);
            rmSync(process.argv[3]+'/.bundle-managed/pending.json');
            console.log(JSON.stringify({ok:true,recovered:true}));process.exit(0);
        }
        appendFileSync(process.env.DEV_START_CALLS,JSON.stringify({kind:'model-bundle',directory:process.argv[3]})+'\\n');
        if(process.env.DEV_START_MODE==='model-bundle-error')process.exit(34);
        if(process.env.DEV_START_MODE==='model-bundle-disk-error'){
            console.log(JSON.stringify({ok:false,error:{code:'ENOSPC',requiredBytes:3*1024**3,availableBytes:1024**3,message:'PRIVATE child details'}}));
            process.exit(1);
        }
        console.log(JSON.stringify({ok:true,downloadOnly:false,verifyOnly:false,models:2,files:9,bytes:4427274223}));`);
    await fs.mkdir(path.join(checkout, 'mcp/neurocenter-asset-sync'), {recursive: true});
    await fs.writeFile(path.join(checkout, 'scripts/package-bridge.sh'), '#!/bin/bash\nexit 0\n', {mode: 0o700});
    await fs.writeFile(path.join(checkout, 'scripts/prepare-bridge-runtimes.mjs'), `
        import {appendFileSync} from 'node:fs';
        appendFileSync(process.env.DEV_START_CALLS,JSON.stringify({kind:'runtime-prepare'})+'\\n');
        if(process.env.DEV_START_MODE==='runtime-error')process.exit(31);`);
    await fs.mkdir(path.join(checkout, 'services/catalog-service/dist/builtin-catalog'), {recursive: true});
    await fs.writeFile(path.join(checkout, 'services/catalog-service/dist/builtin-catalog/sync.cli.js'), `
        require('node:fs').appendFileSync(process.env.DEV_START_CALLS,JSON.stringify({kind:'catalog-sync',
            manifest:process.argv[2],mode:process.argv[3],artifactDir:process.env.RUNTIME_ARTIFACT_DIR})+'\\n');
        if(process.env.DEV_START_MODE==='catalog-error')process.exit(32);
        console.log(JSON.stringify({ok:true,tools:[],partial:false,conflicts:[]}));`);
    const npm = path.join(directory, 'npm-cli.js');
    await fs.writeFile(npm, `
        require('node:fs').appendFileSync(process.env.DEV_START_CALLS,JSON.stringify({kind:'npm',args:process.argv.slice(2)})+'\\n');
    `);
    await fs.writeFile(path.join(bin, 'docker'), `#!${process.execPath}
        const args=process.argv.slice(2);
        require('node:fs').appendFileSync(process.env.DEV_START_CALLS,JSON.stringify({kind:'docker',args})+'\\n');
        if(args.join(' ')==='--version')console.log('Docker version 28.0.0');
        else if(args.join(' ')==='compose version --short')console.log('2.40.3');
        else if(args.join(' ')==='compose up --help')console.log('--wait --wait-timeout');
        else if(args[0]==='info')console.log('28.0.0');
        else if(args.join(' ')==='compose up -d --wait --wait-timeout 45 postgres')console.log('fixture postgres ready');
        else if(args.join(' ')==='compose ps -q postgres')console.log('fixture-postgres');
        else if(args.some(arg=>arg.endsWith('/compose.embedding.yml'))&&args.at(-1)==='embedding'){
            if(process.env.DEV_START_MODE==='model-runtime-error'){
                console.error('PRIVATE fixture Docker failure');process.exitCode=35;
            }else if(process.env.DEV_START_MODE==='model-runtime-cancel'){
                process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
                require('node:fs').appendFileSync(process.env.DEV_START_CALLS,JSON.stringify({kind:'model-runtime-wait',pid:process.pid,entry:process.argv[1]})+'\\n');
            }else console.log('fixture model runtime ready');
        }
        else process.exitCode=93;
    `, {mode: 0o700});
    for (const [name, relative] of services) {
        const entry = path.join(checkout, relative, name === 'frontend' ? 'node_modules/vite/bin/vite.js' : 'dist/main.js');
        await fs.mkdir(path.dirname(entry), {recursive: true});
        await fs.writeFile(entry, `
            const fs=require('node:fs'), service=${JSON.stringify(name)};
            const record=value=>fs.appendFileSync(process.env.DEV_START_CALLS,JSON.stringify(value)+'\\n');
            record({kind:'child-start',service,pid:process.pid,entry:process.argv[1],flagsUrl:process.env.FEATURE_FLAGS_SERVICE_URL});
            process.on('SIGTERM',()=>{record({kind:'child-stop',service,pid:process.pid});process.exit(0);});
            if(service==='catalog'&&!process.env.DEV_START_MODE.startsWith('native-cancel-')){
                const fail=()=>{record({kind:'child-exit',service,pid:process.pid});console.error('fixture catalog failure');process.exit(7);};
                if(process.env.DEV_START_MODE==='immediate')fail();
                const waiting=setInterval(()=>{
                    if(fs.existsSync(process.env.DEV_START_MARKER)){clearInterval(waiting);setTimeout(fail,150);}
                },5);
            }
            setInterval(()=>{},1000);
        `);
    }
    const hook = path.join(directory, 'isolated-network.mjs');
    await fs.writeFile(hook, `
        import fs from 'node:fs';
        import childProcess from 'node:child_process';
        import {EventEmitter} from 'node:events';
        import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
        import {syncBuiltinESMExports} from 'node:module';
        const record=value=>fs.appendFileSync(process.env.DEV_START_CALLS,JSON.stringify(value)+'\\n');
        const deny=()=>{record({kind:'unexpected-network'});throw Error('REAL_NETWORK_FORBIDDEN');};
        const spawn=childProcess.spawn;
        childProcess.spawn=function(...args){
            const child=spawn.apply(this,args),entry=args[1]?.[0];
            if(entry?.startsWith(process.env.DEV_START_CHECKOUT+'/'))record({kind:entry.includes('/scripts/models/')||entry.includes('/scripts/assets/')?'model-child-spawn':'child-spawn',pid:child.pid,entry});
            return child;
        };
        const writeFileSync=fs.writeFileSync;
        fs.writeFileSync=function(filename,...args){
            if(process.env.DEV_START_MODE==='write-error'&&filename===process.env.DEV_START_CHECKOUT+'/.run/processes.json'){
                record({kind:'state-write-error'});
                throw Object.assign(new Error('ENOSPC: fixture cannot save processes.json'),{code:'ENOSPC'});
            }
            return writeFileSync.call(this,filename,...args);
        };
        net.createServer=()=>{
            const server=new EventEmitter();
            server.listen=options=>{
                record({kind:'port-probe',...options});
                if(options.host!=='127.0.0.1'||!options.exclusive||![22222,4100,4200,4300,4400,4000,5173].includes(options.port)){
                    record({kind:'unexpected-probe'});throw Error('REAL_PORT_BIND_FORBIDDEN');
                }
                queueMicrotask(()=>{
                    if(process.env.DEV_START_MODE==='port-conflict'&&options.port===4100){
                        server.emit('error',Object.assign(new Error('fixture occupied port'),{code:'EADDRINUSE'}));
                    }else server.emit('listening');
                });
                return server;
            };
            server.close=callback=>{queueMicrotask(()=>callback?.());return server;};
            server.unref=()=>server;
            return server;
        };
        globalThis.fetch=async (input,options)=>{
            const url=new URL(input);
            record({kind:'health-start',port:url.port,path:url.pathname,search:url.search});
            if(url.hostname!=='127.0.0.1'||!['22222','4100','4200','4300','4400','4000','5173'].includes(url.port))return deny();
            fs.writeFileSync(process.env.DEV_START_MARKER,'started');
            if(process.env.DEV_START_MODE.startsWith('native-cancel-')){
                await new Promise((resolve,reject)=>{
                    const waiting=setTimeout(resolve,60000);
                    const cancel=()=>{clearTimeout(waiting);record({kind:'health-cancel',port:url.port});reject(options.signal.reason);};
                    if(options.signal.aborted)cancel();
                    else options.signal.addEventListener('abort',cancel,{once:true});
                });
            }
            await new Promise(resolve=>setTimeout(resolve,300));
            record({kind:'health-end',port:url.port});
            return url.port==='5173'
                ? new Response('.ant-btn { color: #1677ff; }',{headers:{'Content-Type':'text/css'}})
                : new Response('{"ok":true}',{headers:{'Content-Type':'application/json'}});
        };
        http.request=http.get=https.request=https.get=net.connect=net.createConnection=deny;
        net.Server.prototype.listen=deny;
        syncBuiltinESMExports();
    `);
    const env = {
        PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
        NODE_BIN: process.execPath, NPM_CLI_JS: npm, NO_COLOR: '1', TERM: 'dumb',
        NODE_OPTIONS: '--import=' + pathToFileURL(hook).href,
        DEV_START_CALLS: calls, DEV_START_MARKER: marker, DEV_START_MODE: mode,
        DEV_START_CHECKOUT: checkout,
    };
    async function run() {
        cli = spawn(process.execPath, [path.join(checkout, 'scripts/dev.mjs'), 'up'], {cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe']});
        let stdout = '', stderr = '';
        cli.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
        cli.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
        const timer = setTimeout(() => cli.kill('SIGKILL'), 12000);
        let cancelling=false;
        const cancel=mode==='model-runtime-cancel'||mode.startsWith('native-cancel-')?setInterval(async()=>{
            const awaited=mode==='model-runtime-cancel'?'model-runtime-wait':'health-start';
            if(!cancelling&&(await eventsFrom(calls)).some(event=>event.kind===awaited)){
                cancelling=true;cli.kill(mode==='native-cancel-int'?'SIGINT':'SIGTERM');
            }
        },20):undefined;
        const status = await new Promise((resolve, reject) => {
            cli.once('error', reject);
            cli.once('close', (code, signal) => resolve({code, signal}));
        }).finally(() => {clearTimeout(timer);clearInterval(cancel);});
        const events = await eventsFrom(calls);
        assert.equal(status.signal, null, stdout + stderr);
        assert.ok(events.every(event => !['unexpected-network', 'unexpected-probe'].includes(event.kind)));
        assert.ok(events.filter(event => event.kind === 'docker').every(event => !event.args.includes('down')));
        assert.doesNotMatch(stderr, /REAL_NETWORK_FORBIDDEN/);
        for (const child of events.filter(event => ['child-spawn','model-child-spawn'].includes(event.kind))) {
            const command = spawnSync('ps', ['-ww', '-p', String(child.pid), '-o', 'command='], {encoding: 'utf8'});
            assert.ok(command.status !== 0 || !command.stdout.includes(child.entry), 'CLI оставил процесс ' + child.entry);
        }
        return {...status, stdout, stderr, events};
    }
    return {run, checkout};
}

test('Запуск называет завершившийся сервис, порт, код выхода и его отдельный лог', async t => {
    const f = await fixture(t, 'immediate'), result = await f.run();
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Каталог/);
    assert.match(result.stderr, /4100/);
    assert.match(result.stderr, /код\S*\s+7/);
    assert.match(result.stderr, /neurocenter-catalog\.log/);
    assert.doesNotMatch(result.stdout, /Готов к работе/);
    assert.equal(result.events.filter(event => event.kind === 'npm').length, 8);
    assert.equal(result.events.filter(event => event.kind === 'runtime-prepare').length, 1);
    assert.equal(result.events.filter(event => event.kind === 'catalog-sync').length, 1);
    assert.equal(result.events.find(event => event.kind === 'catalog-sync').artifactDir, path.join(f.checkout, 'data/runtime-artifacts'));
    assert.ok(result.events.findIndex(event => event.kind === 'catalog-sync')
        < result.events.findIndex(event => event.kind === 'child-spawn'));
    assert.ok(result.events.findIndex(event => event.kind === 'runtime-prepare')
        < result.events.findIndex(event => event.kind === 'child-spawn'));
});

test('Ошибка поставки каталога показывает причину и не блокирует запуск сервисов', async t => {
    const f = await fixture(t, 'catalog-error');
    await fs.mkdir(path.join(f.checkout, '.run'));
    const state = '[{"name":"catalog","pid":99999999}]\n';
    const stateFile = path.join(f.checkout, '.run/processes.json');
    await fs.writeFile(stateFile, state);
    const result = await f.run();
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Код завершения: 32/);
    assert.match(result.stderr, /запуск приложения продолжится/);
    assert.match(result.stdout, /npm run tools:sync/);
    assert.notEqual(await fs.readFile(stateFile, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return ''; throw error;
    }), state);
    assert.equal(result.events.filter(event => event.kind === 'catalog-sync').length, 1);
    assert.equal(result.events.find(event => event.kind === 'catalog-sync').mode, '--skip-conflicts');
    assert.equal(result.events.filter(event => event.kind === 'child-spawn').length, 7);
    assert.ok(result.events.some(event => event.kind === 'health-start'));
    assert.match(result.stderr, /Каталог/); // Ошибка тестового сервиса по-прежнему останавливает стек.
});

test('Ошибка подготовки автономного моста сохраняет состояние работающего стека', async t => {
    const f = await fixture(t, 'runtime-error');
    await fs.mkdir(path.join(f.checkout, '.run'));
    const state = '[{"name":"catalog","pid":99999999}]\n';
    const stateFile = path.join(f.checkout, '.run/processes.json');
    await fs.writeFile(stateFile, state);
    const result = await f.run();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /31/);
    assert.equal(await fs.readFile(stateFile, 'utf8'), state);
    assert.equal(result.events.filter(event => event.kind === 'child-spawn').length, 0);
    assert.equal(result.events.filter(event => event.kind === 'health-start').length, 0);
    assert.equal(result.events.filter(event => event.kind === 'docker'
        && event.args[0] === 'compose' && event.args[1] === 'up' && !event.args.includes('--help')).length, 0);
});

test('Ошибка общей поставки останавливает запуск до сборки и сохраняет прежние процессы', async t => {
    const f = await fixture(t, 'assets-error');
    await fs.mkdir(path.join(f.checkout, '.run'));
    const state = '[{"name":"catalog","pid":99999999}]\n', filename = path.join(f.checkout, '.run/processes.json');
    await fs.writeFile(filename, state);
    const result = await f.run();
    assert.equal(result.code, 1); assert.match(result.stderr, /Поставка проекта не подготовлена/);
    assert.equal(await fs.readFile(filename, 'utf8'), state);
    assert.equal(result.events.filter(event => event.kind === 'npm' || event.kind === 'child-spawn').length, 0);
    assert.equal(result.events.filter(event => event.kind === 'docker' && event.args.includes('up') && !event.args.includes('--help')).length, 0);
});

test('CLI запуска восстанавливает прерванную активацию раньше предзагрузки и сборки', async t => {
    const f = await fixture(t, 'assets-recover'), managed = path.join(f.checkout, 'data/embedding/.bundle-managed');
    await fs.mkdir(managed, {recursive: true}); await fs.writeFile(path.join(managed, 'pending.json'), '{}');
    const result = await f.run();
    assert.equal(result.code, 1); assert.match(result.stderr, /Каталог/); // Дальше завершается отдельный тестовый сервис.
    assert.match(result.stdout, /Восстановлен согласованный комплект/);
    const recovery = result.events.findIndex(event => event.kind === 'model-recovery');
    const assets = result.events.findIndex(event => event.kind === 'assets-sync');
    const build = result.events.findIndex(event => event.kind === 'npm');
    assert.ok(recovery >= 0 && assets > recovery && build > assets);
    await assert.rejects(fs.access(path.join(managed, 'pending.json')), {code: 'ENOENT'});
});

test('CLI не запускает предзагрузку и сборку, если журнал моделей нельзя восстановить', async t => {
    const f = await fixture(t, 'assets-recover-error'), managed = path.join(f.checkout, 'data/embedding/.bundle-managed');
    await fs.mkdir(managed, {recursive: true}); await fs.writeFile(path.join(managed, 'pending.json'), '{}');
    await fs.mkdir(path.join(f.checkout, '.run')); const state = '[{"name":"catalog","pid":99999999}]\n';
    await fs.writeFile(path.join(f.checkout, '.run/processes.json'), state);
    const result = await f.run();
    assert.equal(result.code, 1); assert.match(result.stderr, /Не удалось восстановить.*recover-only/);
    assert.equal(await fs.readFile(path.join(f.checkout, '.run/processes.json'), 'utf8'), state);
    assert.equal(result.events.filter(event => ['assets-sync', 'npm', 'child-spawn'].includes(event.kind)).length, 0);
    assert.equal(await fs.readFile(path.join(managed, 'pending.json'), 'utf8'), '{}');
});

test('Ошибка поставки весов сохраняет прежние сервисы и не запускает пустой хостинг', async t => {
    const f = await fixture(t, 'model-bundle-error');
    await fs.mkdir(path.join(f.checkout, '.run'));
    const state = '[{"name":"catalog","pid":99999999}]\n';
    const stateFile = path.join(f.checkout, '.run/processes.json');
    await fs.writeFile(stateFile, state);
    const result = await f.run();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /модели не подготовлены/);
    assert.equal(await fs.readFile(stateFile, 'utf8'), state);
    assert.equal(result.events.filter(event => event.kind === 'model-bundle').length, 1);
    assert.equal(result.events.filter(event => event.kind === 'child-spawn').length, 0);
    assert.equal(result.events.filter(event => event.kind === 'docker' && event.args.includes('embedding')).length, 0);
});

test('Ошибка Docker хостинга объясняется и допускает запуск остальных сервисов',async t=>{
    const f=await fixture(t,'model-runtime-error'),result=await f.run();
    assert.equal(result.code,1,result.stdout+result.stderr); // Тестовый каталог завершается отдельно.
    assert.match(result.stderr,/Хостинг моделей недоступен/);
    assert.match(result.stdout,/код 35/);
    assert.match(result.stdout,/model-hosting/);
    assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE/);
    assert.equal(result.events.filter(event=>event.kind==='catalog-sync').length,1);
    assert.equal(result.events.filter(event=>event.kind==='child-spawn').length,7);
});

test('Нехватка места останавливает запуск с точными объёмами и сохраняет прежний стек',async t=>{
    const f=await fixture(t,'model-bundle-disk-error');
    await fs.mkdir(path.join(f.checkout,'.run'));
    const state='[{"name":"catalog","pid":99999999}]\n',filename=path.join(f.checkout,'.run/processes.json');
    await fs.writeFile(filename,state);
    const result=await f.run();
    assert.equal(result.code,1,result.stdout+result.stderr);
    assert.match(result.stderr,/требуется свободно 3.00 ГиБ, доступно 1.00 ГиБ/);
    assert.match(result.stdout,/Подробности подготовки/);
    assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE/);
    assert.equal(await fs.readFile(filename,'utf8'),state);
    assert.equal(result.events.filter(event=>event.kind==='catalog-sync'||event.kind==='child-spawn').length,0);
    assert.equal(result.events.filter(event=>event.kind==='docker'&&event.args.includes('embedding')).length,0);
});

test('Отмена зависшего хостинга завершает ожидание и сохраняет прежний стек',async t=>{
    const f=await fixture(t,'model-runtime-cancel');
    await fs.mkdir(path.join(f.checkout,'.run'));
    const state='[{"name":"catalog","pid":99999999}]\n',filename=path.join(f.checkout,'.run/processes.json');
    await fs.writeFile(filename,state);
    const result=await f.run();
    assert.equal(result.code,143,result.stdout+result.stderr);
    assert.match(result.stderr,/Прежние сервисы не остановлены/);
    assert.equal(await fs.readFile(filename,'utf8'),state);
    assert.equal(result.events.filter(event=>event.kind==='catalog-sync'||event.kind==='child-spawn').length,0);
    const waiting=result.events.find(event=>event.kind==='model-runtime-wait');
    assert.ok(waiting);
    const command=spawnSync('ps',['-ww','-p',String(waiting.pid),'-o','command='],{encoding:'utf8'});
    assert.ok(command.status!==0||!command.stdout.includes(path.dirname(f.checkout)),command.stdout);
});

test('Сервис, завершившийся во время проверки HTTP, не объявляется готовым', async t => {
    const f = await fixture(t, 'during-health'), result = await f.run();
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Каталог/);
    assert.match(result.stderr, /4100/);
    assert.match(result.stderr, /код\S*\s+7/);
    assert.match(result.stderr, /neurocenter-catalog\.log/);
    assert.doesNotMatch(result.stdout, /Готов к работе/);
    const firstHealth = result.events.findIndex(event => event.kind === 'health-start');
    const exit = result.events.findIndex(event => event.kind === 'child-exit' && event.service === 'catalog');
    const healthEnd = result.events.findIndex(event => event.kind === 'health-end');
    assert.ok(firstHealth >= 0 && firstHealth < exit && exit < healthEnd, JSON.stringify(result.events));
});

for(const [mode,code] of [['native-cancel-int',130],['native-cancel-term',143]]){
    test(`Отмена проверки готовности (${mode}) завершает только сервисы нового запуска`,async t=>{
        const f=await fixture(t,mode),result=await f.run();
        assert.equal(result.code,code,result.stdout+result.stderr);
        assert.match(result.stderr,/Запуск сервисов прерван/);
        assert.doesNotMatch(result.stdout,/Готов к работе/);
        assert.equal(result.events.filter(event=>event.kind==='child-spawn').length,7);
        assert.equal(result.events.filter(event=>event.kind==='health-cancel').length,7);
        await assert.rejects(fs.access(path.join(f.checkout,'.run/processes.json')),{code:'ENOENT'});
    });
}

test('Ошибка записи состояния после запуска процесса не оставляет сервис работать в фоне', async t => {
    const f = await fixture(t, 'write-error'), result = await f.run();
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /ENOSPC/);
    assert.doesNotMatch(result.stdout, /Готов к работе/);
    assert.equal(result.events.filter(event => event.kind === 'state-write-error').length, 1);
    assert.equal(result.events.filter(event => event.kind === 'child-spawn').length, 1);
    assert.equal(result.events.filter(event => event.kind === 'health-start').length, 0);
});

test('Занятый порт объясняется до запуска сервисов и проверки HTTP', async t => {
    const f = await fixture(t, 'port-conflict'), result = await f.run();
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Каталог/);
    assert.match(result.stderr, /4100/);
    assert.match(result.stderr, /занят/);
    assert.doesNotMatch(result.stdout, /Готов к работе/);
    assert.ok(result.events.some(event => event.kind === 'port-probe' && event.port === 4100));
    assert.equal(result.events.filter(event => event.kind === 'child-spawn').length, 0);
    assert.equal(result.events.filter(event => event.kind === 'health-start').length, 0);
});
