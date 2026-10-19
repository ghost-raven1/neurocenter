import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Нативный Bash и реальный архив; сервер подключения одноразовый и не связан с аккаунтом пользователя.
assert.ok(['darwin', 'linux'].includes(process.platform), 'Для Windows нужна отдельная нативная PowerShell-приёмка.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const bridgeVersion = JSON.parse(await fs.readFile(path.join(root, 'mcp/neurocenter-asset-sync/package.json'), 'utf8')).version;
const futureVersion = '0.' + (Number(bridgeVersion.split('.')[1]) + 1) + '.0';
const incompatibleVersion = '0.' + (Number(bridgeVersion.split('.')[1]) - 1) + '.0';
const target = `${process.platform}-${process.arch}${process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : ''}`;
const file = `neurocenter-asset-sync-${target}-${bridgeVersion}.tgz`;
const archive = path.join(root, 'bridge-dist/runtime', file);
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-native-installer-')));
const installDirectory = path.join(temporary, 'папка с пробелами', 'MCP');
const entry = path.join(installDirectory, 'dist/index.js');
const metadata = JSON.parse(await fs.readFile(archive + '.json', 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const deviceId = randomUUID();
let candidateHash, pairStarts = 0, heartbeat, corruptChecksum = false, server, child, origin, fatal;
let expectedEntryInode, paused = false, pauseObservations = 0;
const cases = [];
async function waitFor(predicate, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
    throw new Error('Не дождались: ' + label);
}
async function check(name, action) { await action(); cases.push(name); console.log('OK ' + name); }
async function installer(env, script) {
    return new Promise((resolve, reject) => {
        child = spawn('/bin/bash', [script], { env, cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
        const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Установщик не завершился за 30 секунд.')); }, 30000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('close', code => { clearTimeout(timeout); child = undefined; resolve({ code, output }); });
    });
}
try {
    const bin = path.join(temporary, 'system-bin'); await fs.mkdir(bin);
    for (const command of ['uname', 'sysctl', 'curl', 'tar', 'dirname', 'basename', 'mkdir', 'mktemp', 'rm', 'awk', 'shasum', 'sha256sum', 'grep', 'rmdir', 'mv', 'ldd', 'ps']) {
        const found = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'fixture', command], { encoding: 'utf8' });
        if (found.status === 0 && found.stdout.trim().startsWith('/')) await fs.symlink(found.stdout.trim(), path.join(bin, command));
    }
    const env = { ...process.env, PATH: bin, HOME: temporary, USERPROFILE: temporary,
        XDG_CONFIG_HOME: path.join(temporary, 'config'), NEUROCENTER_BRIDGE_HOME: path.join(temporary, 'private'),
        NEUROCENTER_NO_BROWSER: '1', INSTALL_DIR: installDirectory };
    assert.equal(spawnSync('node', ['--version'], { env }).error?.code, 'ENOENT');
    assert.equal(spawnSync('npm', ['--version'], { env }).error?.code, 'ENOENT');
    server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, origin);
            if (request.method === 'GET' && url.pathname === '/api/bridge/runtime/' + file) {
                response.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': metadata.bytes });
                createReadStream(archive).pipe(response); return;
            }
            if (request.method === 'GET' && url.pathname === '/api/bridge/runtime/' + file + '.sha256') {
                response.end((corruptChecksum ? '0'.repeat(64) : metadata.sha256) + '\n'); return;
            }
            const chunks = []; for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            const token = String(request.headers.authorization || '').replace(/^Bearer /, '');
            const route = url.pathname.replace('/api/device-channel/', ''); let data;
            if (route === 'pair/start') {
                pairStarts++; candidateHash = body.credentialHash;
                data = { deviceCode: 'a'.repeat(64), userCode: 'A'.repeat(16), expiresIn: 600 };
            } else if (route === 'pair/poll') {
                assert.equal(body.deviceCode, 'a'.repeat(64)); data = { state: 'connected', deviceId, email: 'native-fixture@example.test' };
            } else {
                if (digest(token) !== candidateHash) { response.writeHead(401).end('{}'); return; }
                if (route === 'identity') data = { id: deviceId, email: 'native-fixture@example.test', role: 'Разработчик' };
                else if (route === 'heartbeat') { heartbeat = body; data = { ok: true }; }
                else if (route === 'worker/pause') {
                    if (expectedEntryInode) assert.equal((await fs.stat(entry)).ino, expectedEntryInode, 'Пауза должна предшествовать замене файла');
                    pauseObservations++; paused = true; data = { activeJobs: 0 };
                }
                else if (route === 'worker/resume') { paused = false; data = { ok: true }; }
                else if (route === 'jobs/claim') data = null;
                else { response.writeHead(404).end('{}'); return; }
            }
            response.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        } catch { response.writeHead(500).end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
    env.BASE_URL = origin + '/api/bridge';
    const script = path.join(temporary, 'install.sh');
    await fs.writeFile(script, (await fs.readFile(path.join(root, 'bridge-dist/install.sh'), 'utf8')).replaceAll('__BASE_URL__', env.BASE_URL).replaceAll('__RECONNECT__', '0'));
    const profile = path.join(env.NEUROCENTER_BRIDGE_HOME, digest(origin).slice(0, 20));
    const config = path.join(env.XDG_CONFIG_HOME, 'opencode/opencode.json');
    let installedConfig, installedMtime;
    await check('Реальный Bash устанавливает готовый архив без Node/npm, регистрирует MCP и запускает heartbeat', async () => {
        const first = await installer(env, script); assert.equal(first.code, 0, first.output);
        await waitFor(() => heartbeat?.protocolVersion === 2, 'heartbeat автономного worker');
        assert.equal(heartbeat.buildId, metadata.buildId); assert.equal(heartbeat.ragSupported, metadata.ragSupported);
        installedConfig = await fs.readFile(config, 'utf8');
        const setting = JSON.parse(installedConfig).mcp['neurocenter-asset-sync'];
        assert.equal(setting.command[0], await fs.realpath(path.join(installDirectory, 'bin/node')));
        assert.equal(setting.command[1], await fs.realpath(entry));
        assert.equal((await fs.stat(path.join(profile, 'credentials.json'))).mode & 0o777, 0o600);
        assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'credentials.json'), 'utf8')).deviceId, deviceId);
    });
    await check('Повтор реального установщика сохраняет подключение, JSON и резервную копию прежней версии', async () => {
        expectedEntryInode = (await fs.stat(entry)).ino;
        const second = await installer(env, script); assert.equal(second.code, 0, second.output);
        expectedEntryInode = undefined;
        assert.equal(pairStarts, 1); assert.equal(await fs.readFile(config, 'utf8'), installedConfig);
        assert.equal((await fs.readdir(path.dirname(installDirectory))).filter(name => name.startsWith('.neurocenter-previous.')).length, 1);
        installedMtime = (await fs.stat(entry)).mtimeMs;
    });
    await check('Пауза выполняется до замены файлов, завершение обновления снимает её и освобождает mutex', async () => {
        assert.ok(pauseObservations > 0); assert.equal(paused, false);
        await assert.rejects(fs.access(installDirectory + '.install-lock'), { code: 'ENOENT' });
    });
    await check('Неверная SHA256 реального архива оставляет установленный MCP и настройки неизменными', async () => {
        corruptChecksum = true;
        const rejected = await installer(env, script); assert.notEqual(rejected.code, 0); assert.ok(rejected.output.includes('Контрольная сумма'));
        assert.equal((await fs.stat(entry)).mtimeMs, installedMtime); assert.equal(await fs.readFile(config, 'utf8'), installedConfig);
        assert.equal(pairStarts, 1);
    });
    await check('Более новая версия запрещает понижение без замены программы и настроек', async () => {
        corruptChecksum = false;
        const manifest = path.join(installDirectory, 'package.json'); const original = await fs.readFile(manifest, 'utf8');
        const beforeEntry = digest(await fs.readFile(entry)); const beforeMtime = (await fs.stat(entry)).mtimeMs;
        const beforeBackups = (await fs.readdir(path.dirname(installDirectory))).filter(name => name.startsWith('.neurocenter-previous.')).sort();
        await fs.writeFile(manifest, JSON.stringify({ ...JSON.parse(original), version: futureVersion }));
        try {
            const rejected = await installer(env, script); assert.notEqual(rejected.code, 0, rejected.output);
            assert.ok(rejected.output.includes('Автоматическое понижение версии MCP запрещено'), rejected.output);
            assert.equal(JSON.parse(await fs.readFile(manifest, 'utf8')).version, futureVersion);
            assert.equal(digest(await fs.readFile(entry)), beforeEntry); assert.equal((await fs.stat(entry)).mtimeMs, beforeMtime);
            assert.equal(await fs.readFile(config, 'utf8'), installedConfig); assert.equal(pairStarts, 1);
            assert.deepEqual((await fs.readdir(path.dirname(installDirectory))).filter(name => name.startsWith('.neurocenter-previous.')).sort(), beforeBackups);
        } finally { await fs.writeFile(manifest, original); }
    });
    await check('Сбой регистрации сохраняет несовместимую прежнюю версию отдельно без автоматического отката', async () => {
        const manifest = path.join(installDirectory, 'package.json'); const installed = JSON.parse(await fs.readFile(manifest, 'utf8'));
        // Старую версию имитирует только манифест одноразовой установки, исходный архив не меняется.
        await fs.writeFile(manifest, JSON.stringify({ ...installed, version: incompatibleVersion }));
        const sentinel = 'fixture-incompatible-previous.txt'; await fs.writeFile(path.join(installDirectory, sentinel), 'Несовместимую предыдущую установку сохранить');
        const oldManifest = await fs.readFile(manifest, 'utf8'); const oldEntry = digest(await fs.readFile(entry));
        const savedConfig = config + '.saved-fixture'; await fs.rename(config, savedConfig); await fs.mkdir(config);
        const rejected = await installer(env, script); assert.notEqual(rejected.code, 0, rejected.output);
        assert.ok(rejected.output.includes('Регистрация MCP не удалась'), rejected.output);
        assert.ok(rejected.output.includes('автоматический откат на несовместимую версию запрещён'), rejected.output);
        assert.equal(JSON.parse(await fs.readFile(manifest, 'utf8')).version, bridgeVersion);
        assert.equal(JSON.parse(await fs.readFile(path.join(installDirectory, 'runtime.json'), 'utf8')).buildId, metadata.buildId);
        await assert.rejects(fs.access(path.join(installDirectory, sentinel)), { code: 'ENOENT' });
        assert.equal((await fs.lstat(config)).isDirectory(), true); assert.deepEqual(await fs.readdir(config), []);
        assert.equal(await fs.readFile(savedConfig, 'utf8'), installedConfig); assert.equal(pairStarts, 1);
        const previous = [];
        for (const name of (await fs.readdir(path.dirname(installDirectory))).filter(name => name.startsWith('.neurocenter-previous.'))) {
            const directory = path.join(path.dirname(installDirectory), name);
            if (JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')).version === incompatibleVersion) previous.push(directory);
        }
        assert.equal(previous.length, 1);
        assert.equal(await fs.readFile(path.join(previous[0], 'package.json'), 'utf8'), oldManifest);
        assert.equal(digest(await fs.readFile(path.join(previous[0], 'dist/index.js'))), oldEntry);
        assert.equal(await fs.readFile(path.join(previous[0], sentinel), 'utf8'), 'Несовместимую предыдущую установку сохранить');
    });
} catch (error) { fatal = error.stack || String(error); console.error(fatal); process.exitCode = 1; }
finally {
    if (child) child.kill('SIGTERM');
    const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
    for (const line of processes) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (match && match[2].includes(entry) && /--(worker|pair-watch)(?:\s|$)/.test(match[2])) {
            try { process.kill(Number(match[1]), 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
    }
    await delay(200);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(path.dirname(process.env.BRIDGE_NATIVE_REPORT || path.join(root, '.run/bridge-validation', bridgeVersion, 'native-installer.json')), {recursive:true});
    await fs.writeFile(process.env.BRIDGE_NATIVE_REPORT || path.join(root, '.run/bridge-validation', bridgeVersion, 'native-installer.json'), JSON.stringify({ checkedAt: new Date().toISOString(), target, bridgeVersion, buildId: metadata.buildId, archiveSha256: metadata.sha256, cases,
        fatal: fatal || null, noSystemNodeOrNpm: true, pairingServer: 'fixture', realBrowserOpened: false,
        temporaryProfileRemoved: true, realProfileChanged: false }, null, 2) + '\n');
}
