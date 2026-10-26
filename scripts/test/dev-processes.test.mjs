import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {devProcessIdentity} from '../workspace/dev-processes.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const relativeEntry = 'services/catalog-service/dist/main.js';

/** Запускаем только собственные процессы без портов, Docker и подключения к пользовательскому стеку. */
async function fixture(t, checkoutName = 'checkout before rename') {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter dev processes ')));
    const checkout = path.join(directory, checkoutName);
    const children = [];
    t.after(async () => {
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) {
                const exited = once(child, 'exit');
                child.kill('SIGKILL');
                await exited;
            }
        }
        await fs.rm(directory, {recursive: true, force: true});
    });
    await fs.mkdir(path.join(checkout, 'scripts/workspace'), {recursive: true});
    await fs.mkdir(path.dirname(path.join(checkout, relativeEntry)), {recursive: true});
    await fs.mkdir(path.join(checkout, '.run'));
    for (const file of ['dev.sh', 'dev.mjs', 'workspace/node-runtime.mjs', 'workspace/npm-build-environment.mjs', 'workspace/dev-chat-storage.mjs', 'workspace/model-credentials.mjs', 'workspace/model-credential-store.mjs', 'workspace/dev-model-credentials.mjs', 'workspace/dev-snapshots.mjs', 'workspace/docker-build-ca.mjs', 'workspace/docker-build-progress.mjs', 'workspace/compose.mjs',
        'workspace/compose.lock.json', 'workspace/dev-output.mjs', 'workspace/dev-processes.mjs', 'workspace/dev-launch-provenance.mjs', 'workspace/dev-launch-ack.mjs', 'workspace/dev-launch-inspection.mjs', 'workspace/dev-launch-recovery.mjs', 'workspace/dev-watch-owned.mjs', 'workspace/dev-watch-child.mjs', 'workspace/dev-service-health.mjs', 'workspace/dev-listener-origin.mjs']) {
        await fs.copyFile(path.join(root, 'scripts', file), path.join(checkout, 'scripts', file));
    }
    await fs.mkdir(path.join(checkout,'scripts/assets'),{recursive:true});
    await fs.copyFile(path.join(root,'scripts/release-request.mjs'),path.join(checkout,'scripts/release-request.mjs'));
    await fs.copyFile(path.join(root,'scripts/assets/startup.mjs'),path.join(checkout,'scripts/assets/startup.mjs'));
    for(const directory of ['models','embedding','snapshots'])await fs.cp(path.join(root,'scripts',directory),path.join(checkout,'scripts',directory),{recursive:true});
    await fs.writeFile(path.join(checkout, relativeEntry), 'process.send({ready:true});setInterval(()=>{},1000);');
    async function start(entryRoot = checkout, cwd = path.join(entryRoot, 'services/catalog-service')) {
        const child = spawn(process.execPath, [path.join(entryRoot, relativeEntry)], {cwd, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
        children.push(child);
        const signal=AbortSignal.timeout(3000);
        await Promise.race([once(child,'message',{signal}),once(child,'exit',{signal}).then(([code])=>{throw Error(`Owned process exited before readiness (${code}).`);})]);
        return child;
    }
    async function record(checkoutRoot, child, extra = {}) {
        await fs.writeFile(path.join(checkoutRoot, '.run/processes.json'), JSON.stringify([{name: 'catalog', pid: child.pid, ...extra}]));
    }
    function down(checkoutRoot = checkout, overrides = {}) {
        const result = spawnSync('/bin/bash', [path.join(checkoutRoot, 'scripts/dev.sh'), 'down'], {
            cwd: checkoutRoot, env: {PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin'].join(path.delimiter),
                NODE_BIN: process.execPath, NO_COLOR: '1', TERM: 'dumb', ...overrides}, encoding: 'utf8', timeout: 15000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        return result;
    }
    return {directory, checkout, children, start, record, down};
}

function alive(child) {
    try {process.kill(child.pid, 0);return true;}
    catch (error) {if (error.code === 'ESRCH') return false;throw error;}
}

/** Событие exit обновляется после возврата синхронного CLI, поэтому даём родителю обработать его. */
async function settled(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => setTimeout(resolve, 30));
}

for(const saved of [false,true])test(`down останавливает свой сервис флагов ${saved?'по сохранённому PID':'без списка PID'}`,async t=>{
    const f=await fixture(t),directory=path.join(f.checkout,'services/feature-flags-service');
    const entry=path.join(directory,'dist/main.js');await fs.mkdir(path.dirname(entry),{recursive:true});
    await fs.writeFile(entry,'process.send({ready:true});setInterval(()=>{},1000);');
    const child=spawn(process.execPath,[entry],{cwd:directory,stdio:['ignore','ignore','pipe','ipc']});
    f.children.push(child);const signal=AbortSignal.timeout(3000);
    await Promise.race([once(child,'message',{signal}),once(child,'exit',{signal}).then(([code])=>{throw Error(`Owned flags process exited before readiness (${code}).`);})]);
    if(saved)await f.record(f.checkout,child,{name:'flags',identity:devProcessIdentity(child.pid)});
    const result=f.down();await settled(child);
    assert.equal(alive(child),false);assert.match(result.stdout,/Остановлено процессов этого каталога: 1/);
});

test('down останавливает свой процесс после переноса проекта, хотя argv содержит старый путь', async t => {
    const f = await fixture(t), child = await f.start();
    await f.record(f.checkout, child);
    const renamed = path.join(f.directory, 'checkout after rename');
    await fs.rename(f.checkout, renamed);
    const result = f.down(renamed);
    await settled(child);
    assert.equal(alive(child), false, 'Процесс перенесённого проекта должен быть остановлен');
    assert.match(result.stdout, /Остановлено процессов этого каталога: 1/);
    const repeated = f.down(renamed);
    assert.match(repeated.stdout, /Активных процессов этого каталога не найдено/);
});

test('копия processes.json в другом checkout не разрешает остановку исходного проекта', async t => {
    const f = await fixture(t), child = await f.start();
    await f.record(f.checkout, child);
    const copied = path.join(f.directory, 'copied checkout');
    await fs.cp(f.checkout, copied, {recursive: true});
    const result = f.down(copied);
    await settled(child);
    assert.equal(alive(child), true, 'Исходный checkout должен продолжить работу');
    assert.match(result.stdout, /Активных процессов этого каталога не найдено/);
});

test('PID с тем же entry, но чужим рабочим каталогом не принадлежит checkout', async t => {
    const f = await fixture(t), foreign = path.join(f.directory, 'foreign working directory');
    await fs.mkdir(foreign);
    const child = await f.start(f.checkout, foreign);
    await f.record(f.checkout, child);
    const result = f.down();
    await settled(child);
    assert.equal(alive(child), true, 'Совпадения аргумента entry недостаточно для остановки чужого процесса');
    assert.match(result.stdout, /Активных процессов этого каталога не найдено/);
});

test('переиспользованный PID не останавливается из-за пути entry в аргументе другой программы', async t => {
    const f = await fixture(t);
    const child = spawn('/bin/bash', ['-c', 'exec -a "$1" /bin/sleep 30', 'fixture', path.join(f.checkout, relativeEntry)], {
        cwd: path.join(f.checkout, 'services/catalog-service'), stdio: 'ignore',
    });
    f.children.push(child);
    await once(child, 'spawn');
    // Дожидаемся exec: проверяем реальную команду, а не гоняем down против ещё работающего shell.
    let command = '';
    for (let attempt = 0; attempt < 20; attempt++) {
        command = spawnSync('ps', ['-p', String(child.pid), '-o', 'command='], {encoding: 'utf8'}).stdout;
        if (command.startsWith(path.join(f.checkout, relativeEntry))) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(command.startsWith(path.join(f.checkout, relativeEntry)), command);
    await f.record(f.checkout, child);
    const result = f.down();
    await settled(child);
    assert.equal(alive(child), true, 'Упоминание entry в argv другой программы не подтверждает владение');
    assert.match(result.stdout, /Активных процессов этого каталога не найдено/);
});


test('down распознаёт свой Node в пути с кириллицей без UTF-8 locale вызывающего shell', async t => {
    const f = await fixture(t, 'проект с пробелами'), child = await f.start();
    await f.record(f.checkout, child);
    const result = f.down();
    await settled(child);
    assert.equal(alive(child), false, 'Кириллица в пути не должна мешать проверке своего процесса');
    assert.match(result.stdout, /Остановлено процессов этого каталога: 1/);
});


test('сохранённая identity не позволяет остановить другой процесс с переиспользованным PID', async t => {
    const f = await fixture(t), child = await f.start();
    await f.record(f.checkout, child, {identity: 'предыдущий процесс с этим PID'});
    const result = f.down();
    await settled(child);
    assert.equal(alive(child), true, 'Несовпадение identity должно защищать даже Node с тем же entry и cwd');
    assert.match(result.stdout, /Активных процессов этого каталога не найдено/);
});

test('identity своего процесса сохраняется после переноса checkout', async t => {
    const f = await fixture(t), child = await f.start();
    const identity = devProcessIdentity(child.pid);
    assert.ok(identity);
    await f.record(f.checkout, child, {identity});
    const renamed = path.join(f.directory, 'moved checkout with identity');
    await fs.rename(f.checkout, renamed);
    const result = f.down(renamed);
    await settled(child);
    assert.equal(alive(child), false);
    assert.match(result.stdout, /Остановлено процессов этого каталога: 1/);
});

test('down распознаёт собственный процесс без /usr/sbin в пользовательском PATH', async t => {
    const f = await fixture(t), child = await f.start();
    await f.record(f.checkout, child);
    const result = f.down(f.checkout, {PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter)});
    await settled(child);
    assert.equal(alive(child), false, 'Системная проверка cwd не должна зависеть от /usr/sbin в PATH');
    assert.match(result.stdout, /Остановлено процессов этого каталога: 1/);
});


test('down сохраняет владение процессом при смене часового пояса между запусками CLI', async t => {
    const f = await fixture(t), child = await f.start();
    const helper = pathToFileURL(path.join(f.checkout, 'scripts/workspace/dev-processes.mjs')).href;
    const capture = spawnSync(process.execPath, ['--input-type=module', '--eval',
        `import {devProcessIdentity} from ${JSON.stringify(helper)};console.log(devProcessIdentity(Number(process.argv[1])));`, String(child.pid)], {
        cwd: f.checkout, env: {PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), TZ: 'UTC'},
        encoding: 'utf8', timeout: 5000,
    });
    assert.equal(capture.error, undefined);
    assert.equal(capture.status, 0, capture.stderr);
    const identity = capture.stdout.trim();
    assert.ok(identity);
    await f.record(f.checkout, child, {identity});
    const result = f.down(f.checkout, {TZ: 'Asia/Tomsk'});
    await settled(child);
    assert.equal(alive(child), false, 'Часовой пояс shell не должен менять identity работающего процесса');
    assert.match(result.stdout, /Остановлено процессов этого каталога: 1/);
});
