import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Собственные listeners занимают только выданные ОС loopback-порты в отдельном checkout. */
async function fixture(t) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter dev stop ')));
    const checkout = path.join(directory, 'own checkout');
    const serviceDirectory = path.join(checkout, 'services/catalog-service');
    const stateFile = path.join(checkout, '.run/processes.json');
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
    await fs.mkdir(path.join(serviceDirectory, 'dist'), {recursive: true});
    await fs.mkdir(path.join(checkout, '.run'));
    for (const file of ['dev.sh', 'dev.mjs', 'workspace/node-runtime.mjs', 'workspace/compose.mjs',
        'workspace/compose.lock.json', 'workspace/dev-output.mjs', 'workspace/dev-processes.mjs']) {
        await fs.copyFile(path.join(root, 'scripts', file), path.join(checkout, 'scripts', file));
    }
    const entry = path.join(serviceDirectory, 'dist/main.js');
    const worker = `const net=require('node:net');
        if(process.env.DEV_STOP_IGNORE_TERM==='1')process.on('SIGTERM',()=>{});
        const server=net.createServer(socket=>socket.end('isolated fixture'));
        server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));`;
    await fs.writeFile(entry, worker);
    async function listener({foreign = false, ignoreTerm = false, entryKind = 'catalog'} = {}) {
        let cwd = serviceDirectory, args = [entry];
        if (entryKind === 'nest') args = ['--enable-source-maps', 'dist/main'];
        if (entryKind === 'eval') args = ['--eval', worker.replace(/\s+/g, ' '), 'dist/main.js'];
        if (['other', 'other-absolute'].includes(entryKind)) {
            const other = path.join(serviceDirectory, 'other.js');
            await fs.writeFile(other, worker);
            args = entryKind === 'other' ? ['other.js', 'dist/main.js']
                : [other, './services/catalog-service/dist/main.js'];
        }
        if (entryKind === 'vite') {
            cwd = path.join(checkout, 'frontend');
            const executable = path.join(cwd, 'node_modules/vite/bin/vite.js');
            const shortcut = path.join(cwd, 'node_modules/.bin/vite');
            await fs.mkdir(path.dirname(executable), {recursive: true});
            await fs.mkdir(path.dirname(shortcut), {recursive: true});
            await fs.writeFile(executable, worker);
            await fs.symlink('../vite/bin/vite.js', shortcut);
            args = [shortcut];
        }
        if (foreign) cwd = path.join(directory, 'foreign working directory');
        await fs.mkdir(cwd, {recursive: true});
        const child = spawn(process.execPath, args, {cwd,
            env: {DEV_STOP_IGNORE_TERM: ignoreTerm ? '1' : '0'}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
        children.push(child);
        const [message] = await once(child, 'message');
        assert.ok(Number.isSafeInteger(message.port) && message.port > 0);
        return {child, port: message.port};
    }
    async function state(records) {await fs.writeFile(stateFile, JSON.stringify(records));}
    function down() {
        const result = spawnSync('/bin/bash', [path.join(checkout, 'scripts/dev.sh'), 'down'], {
            cwd: checkout, env: {PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin'].join(path.delimiter),
                NODE_BIN: process.execPath, NO_COLOR: '1', TERM: 'dumb'}, encoding: 'utf8', timeout: 20000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        return result;
    }
    return {checkout, stateFile, listener, state, down};
}

/** Проверяем фактическое освобождение сокета, не только текст CLI или сигнал процессу. */
async function portError(port) {
    const server = net.createServer();
    const error = await new Promise(resolve => {
        server.once('error', resolve);
        server.listen(port, '127.0.0.1', () => resolve(null));
    });
    if (server.listening) await new Promise(resolve => server.close(resolve));
    return error;
}

for (const saved of ['missing', 'empty', 'dead', 'corrupt', 'invalid']) {
    const label = {missing: 'без processes.json', empty: 'с пустым processes.json',
        dead: 'с устаревшим PID в processes.json', corrupt: 'с повреждённым JSON состояния',
        invalid: 'с некорректным элементом [null] в списке PID'}[saved];
    test(`down ${label} находит свой сервис и освобождает занятый им порт`, {timeout: 25000}, async t => {
        const f = await fixture(t), own = await f.listener();
        if (saved === 'empty') await f.state([]);
        if (saved === 'invalid') await f.state([null]);
        if (saved === 'corrupt') await fs.writeFile(f.stateFile, '{');
        if (saved === 'dead') {
            const exited = spawnSync(process.execPath, ['--eval', ''], {encoding: 'utf8', timeout: 5000});
            assert.equal(exited.status, 0, exited.stderr);
            await f.state([{name: 'catalog', pid: exited.pid}]);
        }
        assert.equal((await portError(own.port))?.code, 'EADDRINUSE');
        const result = f.down();
        assert.equal(await portError(own.port), null, 'Порт своего неучтённого сервиса должен освободиться до завершения down');
        assert.match(result.stdout, /Остановлено процессов этого каталога: 1/);
    });
}

test('поиск неучтённых сервисов не останавливает listener с тем же entry и чужим cwd', {timeout: 25000}, async t => {
    const f = await fixture(t), foreign = await f.listener({foreign: true});
    const result = f.down();
    assert.equal((await portError(foreign.port))?.code, 'EADDRINUSE', 'Порт чужого рабочего каталога должен остаться занят');
    assert.doesNotThrow(() => process.kill(foreign.child.pid, 0));
    assert.match(result.stdout, /Активных процессов этого каталога не найдено/);
});

test('down дожидается освобождения порта сервиса, игнорирующего SIGTERM', {timeout: 25000}, async t => {
    const f = await fixture(t), own = await f.listener({ignoreTerm: true});
    await f.state([{name: 'catalog', pid: own.child.pid}]);
    assert.equal((await portError(own.port))?.code, 'EADDRINUSE');
    const result = f.down();
    assert.equal(await portError(own.port), null, 'SIGKILL должен освободить порт до успешного завершения down');
    assert.match(result.stdout, /Остановлено процессов этого каталога: 1/);
});


for (const entryKind of ['nest', 'vite']) {
    const label = entryKind === 'nest' ? 'Nest CLI: node --enable-source-maps dist/main' : 'npm Vite через node_modules/.bin/vite';
    test(`down находит неучтённый ${label} и освобождает его порт`, {timeout: 25000}, async t => {
        const f = await fixture(t), own = await f.listener({entryKind});
        assert.equal((await portError(own.port))?.code, 'EADDRINUSE');
        const result = f.down();
        assert.equal(await portError(own.port), null, 'Поддерживаемая команда запуска должна распознаваться без processes.json');
        assert.match(result.stdout, /Остановлено процессов этого каталога: 1/);
    });
}


for (const entryKind of ['eval', 'other', 'other-absolute']) {
    const label = {eval: 'node --eval с аргументом dist/main.js', other: 'node other.js dist/main.js',
        'other-absolute': 'node с абсолютным other.js и относительным аргументом пути сервиса'}[entryKind];
    test(`поиск неучтённых сервисов сохраняет ${label} в cwd сервиса`, {timeout: 25000}, async t => {
        const f = await fixture(t), unrelated = await f.listener({entryKind});
        const result = f.down();
        assert.equal((await portError(unrelated.port))?.code, 'EADDRINUSE', 'Аргумент dist/main.js не превращает другой скрипт в сервис проекта');
        assert.doesNotThrow(() => process.kill(unrelated.child.pid, 0));
        assert.match(result.stdout, /Активных процессов этого каталога не найдено/);
    });
}
