import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {readBridgeTemplate} from '../workspace/bridge-templates.mjs';

// Нативный Bash и реальный архив; сервер подключения одноразовый и не связан с аккаунтом пользователя.
assert.ok(['darwin', 'linux'].includes(process.platform), 'Для Windows нужна отдельная нативная PowerShell-приёмка.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const bridgeVersion = JSON.parse(await fs.readFile(path.join(root, 'mcp/neurocenter-asset-sync/package.json'), 'utf8')).version;
const futureVersion = '0.' + (Number(bridgeVersion.split('.')[1]) + 1) + '.0';
const incompatibleVersion = '0.' + (Number(bridgeVersion.split('.')[1]) - 1) + '.0';
const target = `${process.platform}-${process.arch}${process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : ''}`;
const file = `neurocenter-asset-sync-${target}-${bridgeVersion}.tgz`;
const archive = path.join(process.env.TEST_RUNTIME_DIR || path.join(root, 'bridge-dist/runtime'), file);
let siteOrigin = 'http://panel.fixture.test:5173';
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-native-installer-')));
const installDirectory = path.join(temporary, 'папка с пробелами', 'MCP');
const entry = path.join(installDirectory, 'dist/index.js');
const metadata = JSON.parse(await fs.readFile(archive + '.json', 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const deviceId = randomUUID();
let candidateHash, pairStarts = 0, heartbeat, heartbeatWorkerPid, corruptChecksum = false, server, child, origin, fatal, installerFailure;
let expectedEntryInode, paused = false, pauseObservations = 0;
let activeJobs = 0, savedCompletion, completionDeliveries = 0, repeatedActionRequests = 0;
let archiveRequests=0;
let cleanupAuthority=false;
const rejectedRoutes = [];
const pairAuthorizations = [];
const cases = [];
async function waitFor(predicate, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
    throw new Error('Не дождались: ' + label);
}
async function check(name, action) {
    await action(); cases.push(name); console.log('OK ' + name);
    // Each case has already checked its own backup; do not accumulate many unpacked runtimes on a small QA disk.
    for (const folder of await fs.readdir(path.dirname(installDirectory))) {
        if (folder.startsWith('.neurocenter-previous.')) await fs.rm(path.join(path.dirname(installDirectory), folder), { recursive: true, force: true });
    }
}
async function installer(env, script) {
    return new Promise((resolve, reject) => {
        child = spawn('/bin/bash', [script], { env, cwd: temporary, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const running = child, limit = 128 * 1024;
        let output = '', stdout = '', stderr = '', timedOut = false, termination, closed = false, escalationDone = false, exitCode;
        running.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-limit); output = (output + chunk).slice(-limit); });
        running.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-limit); output = (output + chunk).slice(-limit); });
        const stop = signal => { try { process.kill(-running.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
        const groupEmpty = () => { try { process.kill(-running.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } };
        const finish = () => {
            if (!closed || timedOut && !escalationDone) { return; }
            if (timedOut) {
                installerFailure = { ...installerFailure, stdout, stderr };
                reject(new Error('Установщик не завершился за 30 секунд. Вывод сохранён в installerFailure отчёта.'));
            } else { resolve({ code: exitCode, output }); }
        };
        const timeout = setTimeout(() => {
            timedOut = true;
            installerFailure = { argv: ['/bin/bash', script], cwd: temporary, timeoutMs: 30000, environmentKeys: Object.keys(env).sort(), stdout, stderr };
            stop('SIGTERM'); termination = setTimeout(() => { stop('SIGKILL'); escalationDone = true; finish(); }, 1000);
        }, 30000);
        running.once('error', error => { clearTimeout(timeout); clearTimeout(termination); reject(error); });
        running.once('close', code => {
            clearTimeout(timeout); closed = true; exitCode = code; child = undefined;
            if (timedOut && groupEmpty()) { clearTimeout(termination); escalationDone = true; }
            finish();
        });
    });
}
/** Linux отдаёт точные Unicode-аргументы через /proc независимо от locale терминала. */
async function ownsLinuxFixtureProcess(pid, modes) {
    try {
        if ((await fs.stat(`/proc/${pid}`)).uid !== process.getuid()) return false;
        const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
        return args.some((argument, index) => argument === entry && modes.includes(args[index + 1]));
    } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code)) return false;
        throw error;
    }
}
/** Завершаем только worker одноразового профиля после проверки владельца и entry. */
async function stopFixtureWorker(profile) {
    const lock = path.join(profile, 'worker.lock');
    await waitFor(() => fs.access(lock).then(() => true, () => false), 'блокировка worker одноразового профиля');
    await waitFor(async () => heartbeatWorkerPid === Number(await fs.readFile(lock, 'utf8')),
        'heartbeat текущего worker после регистрации обработчиков завершения');
    const pid = Number(await fs.readFile(lock, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
    if (process.platform === 'linux') {
        assert.ok(await ownsLinuxFixtureProcess(pid, ['--worker']), 'PID должен принадлежать worker одноразового профиля');
    } else {
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'uid=', '-o', 'args='], { encoding: 'utf8' }).trim();
        const owner = /^(\d+)\s+([\s\S]*)$/.exec(command);
        assert.equal(Number(owner?.[1]), process.getuid());
        assert.ok(owner?.[2].includes(entry) && /--worker(?:\s|$)/.test(owner[2]), 'PID должен принадлежать worker одноразового профиля');
    }
    process.kill(pid, 'SIGTERM');
    await waitFor(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    }, 'завершение worker одноразового профиля');
    await assert.rejects(fs.access(lock), { code: 'ENOENT' });
    return pid;
}
try {
    const bin = path.join(temporary, 'system-bin'); await fs.mkdir(bin);
    for (const command of ['uname', 'sysctl', 'curl', 'tar', 'gzip', 'cat', 'dirname', 'basename', 'mkdir', 'mktemp', 'rm', 'awk', 'shasum', 'sha256sum', 'grep', 'rmdir', 'mv', 'ldd', 'ps']) {
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
                archiveRequests++;
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
                pairAuthorizations.push(!!token);
                pairStarts++; candidateHash = body.credentialHash;
                data = { deviceCode: 'a'.repeat(64), userCode: 'A'.repeat(16), expiresIn: 600 };
            } else if (route === 'pair/poll') {
                assert.equal(body.deviceCode, 'a'.repeat(64)); data = { state: 'connected', deviceId, email: 'native-fixture@example.test' };
            } else {
                if (digest(token) !== candidateHash) { rejectedRoutes.push(route); response.writeHead(401).end('{}'); return; }
                if (route === 'identity') data = { id: deviceId, email: 'native-fixture@example.test', role: 'Разработчик' };
                else if (route === 'heartbeat') {
                    heartbeat = body;
                    const pid = Number(await fs.readFile(path.join(profile, 'worker.lock'), 'utf8'));
                    const version = JSON.parse(await fs.readFile(path.join(profile, 'worker-version.json'), 'utf8'));
                    if (version.pid === pid) heartbeatWorkerPid = pid;
                    data = { ok: true };
                }
                else if (route === 'worker/pause') {
                    if (expectedEntryInode) assert.equal((await fs.stat(entry)).ino, expectedEntryInode, 'Пауза должна предшествовать замене файла');
                    pauseObservations++; paused = true; data = { activeJobs };
                }
                else if (route === 'worker/resume') { paused = false; data = { ok: true }; }
                else if (route === 'worker/update-cleanup/authorize' && cleanupAuthority) data = { ok: true };
                else if (savedCompletion && route === `jobs/${savedCompletion.id}/complete`) {
                    assert.deepEqual(body, savedCompletion); completionDeliveries++; activeJobs = 0; data = { ok: true };
                }
                else if (savedCompletion && route.startsWith(`jobs/${savedCompletion.id}/`)) {
                    repeatedActionRequests++; response.writeHead(409).end('{}'); return;
                }
                else if (route === 'jobs/claim') data = null;
                else { response.writeHead(404).end('{}'); return; }
            }
            response.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        } catch { response.writeHead(500).end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
    env.BASE_URL = origin + '/api/bridge';
    const script = path.join(temporary, 'install.sh');
    await fs.writeFile(script, (await readBridgeTemplate(path.join(root, 'bridge-dist/install.sh'))).replaceAll('__BRIDGE_VERSION__', bridgeVersion).replaceAll('__BASE_URL__', env.BASE_URL).replaceAll('__SITE_URL__', siteOrigin).replaceAll('__RECONNECT__', '0'));
    let profile = path.join(env.NEUROCENTER_BRIDGE_HOME, digest(siteOrigin).slice(0, 20));
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
        assert.equal(setting.environment.NEUROCENTER_URL, siteOrigin);
        assert.equal(setting.environment.NEUROCENTER_API_URL, origin);
        assert.equal((await fs.stat(path.join(profile, 'credentials.json'))).mode & 0o777, 0o600);
        assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'credentials.json'), 'utf8')).deviceId, deviceId);
    });
    await check('Подключение без launcher использует прежний runtime и ключи без повторного скачивания архива',async()=>{
        const beforeArchive=archiveRequests,beforeProgram=await fs.stat(entry),beforeCredentials=await fs.readFile(path.join(profile,'credentials.json'));
        await fs.unlink(path.join(temporary,'.local/bin/neurocenter-bridge'));
        const connectScript=path.join(temporary,'connect.sh');
        await fs.writeFile(connectScript,(await readBridgeTemplate(path.join(root,'bridge-dist/connect.sh'))).replaceAll('__BASE_URL__',env.BASE_URL).replaceAll('__SITE_URL__',siteOrigin).replaceAll('__RECONNECT__','0'));
        const result=await installer(env,connectScript);assert.equal(result.code,0,result.output);
        assert.match(result.output,/Существующее подключение сохранено/);assert.equal(archiveRequests,beforeArchive);assert.equal(pairStarts,1);
        assert.equal((await fs.stat(entry)).ino,beforeProgram.ino);assert.equal((await fs.stat(entry)).mtimeMs,beforeProgram.mtimeMs);
        assert.deepEqual(await fs.readFile(path.join(profile,'credentials.json')),beforeCredentials);assert.equal(await fs.readFile(config,'utf8'),installedConfig);
        await fs.access(path.join(temporary,'.local/bin/neurocenter-bridge'));assert.equal(paused,false);
    });
    await check('Managed launcher восстанавливает нестандартный root без INSTALL_DIR и повторного скачивания архива',async()=>{
        const beforeArchive=archiveRequests,beforeProgram=await fs.stat(entry),beforeCredentials=await fs.readFile(path.join(profile,'credentials.json'));
        assert.ok((await fs.readFile(path.join(temporary,'.local/bin/neurocenter-bridge'),'utf8')).includes('Neurocenter bridge command v1'));
        const connectScript=path.join(temporary,'connect-custom-root.sh');
        await fs.writeFile(connectScript,(await readBridgeTemplate(path.join(root,'bridge-dist/connect.sh'))).replaceAll('__BASE_URL__',env.BASE_URL).replaceAll('__SITE_URL__',siteOrigin).replaceAll('__RECONNECT__','0'));
        const result=await installer({...env,INSTALL_DIR:undefined},connectScript);assert.equal(result.code,0,result.output);
        assert.match(result.output,/Существующее подключение сохранено/);assert.equal(archiveRequests,beforeArchive);assert.equal(pairStarts,1);
        assert.equal((await fs.stat(entry)).ino,beforeProgram.ino);assert.equal((await fs.stat(entry)).mtimeMs,beforeProgram.mtimeMs);
        assert.deepEqual(await fs.readFile(path.join(profile,'credentials.json')),beforeCredentials);assert.equal(await fs.readFile(config,'utf8'),installedConfig);assert.equal(paused,false);
    });
    await check('Короткая команда использует bundled Node, сохранённый Gateway и существующее подключение', async () => {
        const command = path.join(temporary, '.local/bin/neurocenter-bridge');
        const result = await new Promise((resolve, reject) => {
            const process = spawn(command, ['connect', '--open'], { env, cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '', stderr = ''; process.stdout.on('data', value => stdout += value); process.stderr.on('data', value => stderr += value);
            const timeout = setTimeout(() => { process.kill('SIGTERM'); reject(Error('Короткая команда не завершилась.')); }, 10000);
            process.once('error', cause => { clearTimeout(timeout); reject(cause); }); process.once('close', status => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
        });
        assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Существующее подключение сохранено/);
        assert.equal(pairStarts, 1); assert.doesNotMatch(result.stdout, /"connected"|"deviceId"/);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(installDirectory, 'installation.json'), 'utf8')), { schemaVersion: 1, siteUrl: siteOrigin, apiUrl: origin });
        assert.equal((await fs.stat(command)).mode & 0o700, 0o700);
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
    await check('Реальный установщик сохраняет мёртвую cleanup-блокировку в карантин, а очистка ждёт lease и подтверждённую паузу', async () => {
        const credentialsBefore=await fs.readFile(path.join(profile,'credentials.json')),pairsBefore=pairStarts;
        const actionsBefore=repeatedActionRequests,deliveriesBefore=completionDeliveries;
        const {default:cleanup}=await import(pathToFileURL(path.join(installDirectory,'dist/shared/bridge-update-cleanup.cjs')).href);
        const exited=spawn(path.join(installDirectory,'bin/node'),['-e','process.exit(0)'],{env,stdio:'ignore'});
        await new Promise((resolve,reject)=>{exited.once('error',reject);exited.once('close',code=>code===0?resolve():reject(Error('Owned stale-lock fixture did not exit.')));});
        assert.ok(Number.isSafeInteger(exited.pid)&&exited.pid>1&&exited.pid!==process.pid);
        await waitFor(()=>{try{process.kill(exited.pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}},'подтверждённый выход владельца тестовой блокировки');
        const control=await cleanup.controlRootForInstallRoot(installDirectory),lock=path.join(control,'lock.json');
        await waitFor(()=>fs.access(lock).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;}),'освобождение cleanup перед тестовым dead owner');
        const deadOwner={schemaVersion:1,pid:exited.pid,token:randomUUID()},deadBytes=Buffer.from(JSON.stringify(deadOwner));
        await fs.writeFile(lock,deadBytes,{flag:'wx',mode:0o600,flush:true});const deadStat=await fs.stat(lock,{bigint:true});
        const installed=await installer(env,script);assert.equal(installed.code,0,installed.output);
        await waitFor(async()=>{const pid=await fs.readFile(path.join(profile,'worker.lock'),'utf8').catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});return pid!==undefined&&heartbeatWorkerPid===Number(pid);},'heartbeat перед очисткой старых версий');
        assert.ok(heartbeat.capabilities.includes('bridge-update-current-only-v1'));
        const quarantines=path.join(control,'quarantine'),quarantined=(await fs.readdir(quarantines)).filter(name=>name.startsWith('lock-'+deadOwner.token+'-')&&name.endsWith('.json')&&!name.endsWith('.receipt.json'));
        assert.equal(quarantined.length,1);const preserved=path.join(quarantines,quarantined[0]),preservedStat=await fs.stat(preserved,{bigint:true});
        assert.equal(preservedStat.ino,deadStat.ino);assert.equal(preservedStat.dev,deadStat.dev);assert.deepEqual(await fs.readFile(preserved),deadBytes);
        const receipt=JSON.parse(await fs.readFile(preserved+'.receipt.json','utf8'));
        assert.equal(receipt.action,'quarantined-dead-cleanup-owner');assert.equal(receipt.ownerPid,exited.pid);assert.equal(receipt.sha256,digest(deadBytes));
        assert.deepEqual(receipt.identity,{dev:String(deadStat.dev),ino:String(deadStat.ino)});assert.equal(receipt.installRoot,installDirectory);assert.equal(receipt.quarantine,preserved);
        const backups=async()=>(await fs.readdir(path.dirname(installDirectory))).filter(name=>name.startsWith('.neurocenter-previous.'));
        assert.equal((await backups()).length,1);
        // A real installed lease represents another active consumer; neither maintenance nor CLI may bypass it.
        let lease=await cleanup.acquireRuntimeUseLease(installDirectory,{required:true});
        const commandEnvironment={...env,NEUROCENTER_URL:siteOrigin,NEUROCENTER_API_URL:origin};
        const run=async command=>{
            const filename=path.join(temporary,'current-only-command.sh');
            await fs.writeFile(filename,'#!/bin/bash\nset -eu\n'+command+'\n');
            return installer(commandEnvironment,filename);
        };
        cleanupAuthority=true;
        try{
            const active=await run('exec "$INSTALL_DIR/bin/node" "$INSTALL_DIR/dist/index.js" --cleanup-updates');
            assert.equal(active.code,0,active.output);assert.equal(JSON.parse(active.output.trim()).removed,0);assert.equal((await backups()).length,1);
            const prepared=await run('exec "$INSTALL_DIR/bin/node" "$INSTALL_DIR/dist/index.js" --prepare-upgrade "$INSTALL_DIR/dist/index.js"');
            assert.equal(prepared.code,0,prepared.output);assert.equal(JSON.parse(prepared.output.trim()).paused,true);assert.equal(paused,true);
            await assert.rejects(fs.access(path.join(profile,'worker.lock')),{code:'ENOENT'});
            // The worker is stopped: only the declared foreign consumer now protects the old runtime.
            await fs.writeFile(path.join(temporary,'lease-proof.cjs'),`const path=require("node:path");
const cleanup=require(path.join(process.env.INSTALL_DIR,"dist/shared/bridge-update-cleanup.cjs"));
(async()=>{let beforeDeleteCalls=0;const result=await cleanup.cleanupSuccessfulBackups({installRoot:process.env.INSTALL_DIR,policy:cleanup.normalizeCleanupPolicy(),beforeDelete:async()=>{beforeDeleteCalls++;throw Error("Active consumer must be preserved.");}});console.log(JSON.stringify({result,beforeDeleteCalls}));})().catch(error=>{console.error(error.message);process.exitCode=1;});\n`);
            const protectedBackup=await run('exec "$INSTALL_DIR/bin/node" "$HOME/lease-proof.cjs"');
            assert.equal(protectedBackup.code,0,protectedBackup.output);const proof=JSON.parse(protectedBackup.output.trim());
            assert.equal(proof.beforeDeleteCalls,0);assert.deepEqual(proof.result.removed,[]);assert.deepEqual(proof.result.warnings,[]);
            const remaining=await backups();assert.equal(remaining.length,1);
            assert.ok(proof.result.kept.some(item=>item.reason==='runtime-in-use'&&item.path===path.join(path.dirname(installDirectory),remaining[0])));
            await lease.release();lease=undefined;
            const purged=await run('exec "$INSTALL_DIR/bin/node" "$INSTALL_DIR/dist/index.js" --cleanup-updates');
            assert.equal(purged.code,0,purged.output);assert.deepEqual(JSON.parse(purged.output.trim()),{ok:true,removed:1,warnings:0});
            assert.equal((await backups()).length,0);
            heartbeat=undefined;
            const resumed=await run('"$INSTALL_DIR/bin/node" "$INSTALL_DIR/dist/index.js" --finish-upgrade\nexec "$HOME/.local/bin/neurocenter-bridge" connect --open');
            assert.equal(resumed.code,0,resumed.output);await waitFor(()=>!!heartbeat,'heartbeat после очистки и снятия паузы');
            assert.equal(paused,false);assert.equal(pairStarts,pairsBefore);assert.equal(repeatedActionRequests,actionsBefore);assert.equal(completionDeliveries,deliveriesBefore);
            assert.deepEqual(await fs.readFile(path.join(profile,'credentials.json')),credentialsBefore);assert.equal(await fs.readFile(config,'utf8'),installedConfig);
            assert.equal((await backups()).length,0);installedMtime=(await fs.stat(entry)).mtimeMs;
        }finally{cleanupAuthority=false;await lease?.release();}
    });
    await check('Мёртвый worker с серверным заданием обновляется и доставляет сохранённый результат без повторной записи файлов', async () => {
        const stoppedPid = await stopFixtureWorker(profile);
        // Восстанавливаем именно stale PID после аварии, не создавая чужой процесс.
        await fs.writeFile(path.join(profile, 'worker.lock'), String(stoppedPid), { mode: 0o600 });
        const completedFile = path.join(temporary, 'уже установленный инструмент.txt');
        const content = 'Файловое действие уже выполнено; повторять его нельзя.';
        await fs.writeFile(completedFile, content);
        const before = await fs.stat(completedFile);
        savedCompletion = { id: randomUUID(), lease: randomUUID(), deviceId, state: 'succeeded',
            message: 'Файлы установлены', result: { files: 1, changed: 1, digest: digest(content) } };
        const outbox = path.join(profile, 'completions', savedCompletion.id + '.json');
        await fs.mkdir(path.dirname(outbox), { recursive: true, mode: 0o700 });
        await fs.writeFile(outbox, JSON.stringify(savedCompletion), { mode: 0o600 });
        activeJobs = 1; heartbeat = undefined;
        const upgraded = await installer(env, script); assert.equal(upgraded.code, 0, upgraded.output);
        await waitFor(() => completionDeliveries === 1 && !!heartbeat, 'доставка сохранённого результата новым worker');
        await waitFor(() => fs.access(outbox).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; }), 'подтверждение доставки в outbox');
        assert.equal(activeJobs, 0); assert.equal(completionDeliveries, 1); assert.equal(repeatedActionRequests, 0);
        const after = await fs.stat(completedFile);
        assert.equal(await fs.readFile(completedFile, 'utf8'), content);
        assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
        assert.equal(await fs.readFile(config, 'utf8'), installedConfig); assert.equal(pairStarts, 1);
        assert.equal(paused, false); await assert.rejects(fs.access(installDirectory + '.install-lock'), { code: 'ENOENT' });
    });
    await check('Просроченный ключ без worker не блокирует обновление и доходит до повторного подключения', async () => {
        await stopFixtureWorker(profile);
        const oldCredentials = JSON.parse(await fs.readFile(path.join(profile, 'credentials.json'), 'utf8'));
        candidateHash = digest('отозванный одноразовый ключ'); heartbeat = undefined;
        const pausesBefore = pauseObservations; const rejectedBefore = rejectedRoutes.length;
        const repaired = await installer(env, script); assert.equal(repaired.code, 0, repaired.output);
        assert.match(repaired.output, /Подключение ждёт подтверждения/);
        await waitFor(() => !!heartbeat && pairStarts === 2, 'подключение и heartbeat после замены просроченного ключа');
        const fresh = JSON.parse(await fs.readFile(path.join(profile, 'credentials.json'), 'utf8'));
        assert.notEqual(fresh.token, oldCredentials.token); assert.equal(fresh.deviceId, deviceId);
        assert.equal(digest(fresh.token), candidateHash);
        const denied = rejectedRoutes.slice(rejectedBefore);
        assert.ok(!denied.includes('worker/pause'), 'Без живого worker установщик не запрашивает серверную паузу'); assert.ok(denied.includes('identity'));
        assert.ok(!denied.includes('worker/resume'), 'Без установленной паузы не нужен resume с отозванным ключом');
        assert.equal(pauseObservations, pausesBefore); assert.equal(paused, false);
        assert.equal(completionDeliveries, 1); assert.equal(repeatedActionRequests, 0);
        assert.equal(await fs.readFile(config, 'utf8'), installedConfig);
        await assert.rejects(fs.access(path.join(profile, 'pair.json')), { code: 'ENOENT' });
        await assert.rejects(fs.access(installDirectory + '.install-lock'), { code: 'ENOENT' });
        installedMtime = (await fs.stat(entry)).mtimeMs;
    });
    await check('Установщик другой площадки сохраняет прежние ключи и запускает новый heartbeat после подтверждения', async () => {
        const previousProfile=profile,previousCredentials=await fs.readFile(path.join(profile,'credentials.json'));
        const beforeConfig=JSON.parse(await fs.readFile(config,'utf8'));
        siteOrigin='http://next-panel.fixture.test:5173';env.SITE_URL=siteOrigin;
        profile=path.join(env.NEUROCENTER_BRIDGE_HOME,digest(siteOrigin).slice(0,20));heartbeat=undefined;
        const migrated=await installer(env,script);assert.equal(migrated.code,0,migrated.output);
        assert.match(migrated.output,/Подключение ждёт подтверждения/);
        await waitFor(()=>!!heartbeat&&pairStarts===3,'новое подтверждение и heartbeat после перехода площадки');
        const current=JSON.parse(await fs.readFile(config,'utf8'));
        beforeConfig.mcp['neurocenter-asset-sync'].environment.NEUROCENTER_URL=siteOrigin;
        assert.deepEqual(current,beforeConfig);
        assert.deepEqual(await fs.readFile(path.join(previousProfile,'credentials.json')),previousCredentials);
        const credentials=JSON.parse(await fs.readFile(path.join(profile,'credentials.json'),'utf8'));
        assert.notEqual(credentials.token,JSON.parse(previousCredentials).token);assert.equal(pairAuthorizations.at(-1),false);
        assert.equal(heartbeatWorkerPid,Number(await fs.readFile(path.join(profile,'worker.lock'),'utf8')));
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(installDirectory,'installation.json'),'utf8')),{schemaVersion:1,siteUrl:siteOrigin,apiUrl:origin});
        assert.equal(paused,false);await assert.rejects(fs.access(path.join(previousProfile,'worker.lock')),{code:'ENOENT'});
        installedConfig=await fs.readFile(config,'utf8');installedMtime=(await fs.stat(entry)).mtimeMs;
    });
    await check('Неверная SHA256 реального архива оставляет установленный MCP и настройки неизменными', async () => {
        corruptChecksum = true;
        const rejected = await installer(env, script); assert.notEqual(rejected.code, 0); assert.ok(rejected.output.includes('Контрольная сумма'));
        assert.equal((await fs.stat(entry)).mtimeMs, installedMtime); assert.equal(await fs.readFile(config, 'utf8'), installedConfig);
        assert.equal(pairStarts, 3);
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
            assert.equal(await fs.readFile(config, 'utf8'), installedConfig); assert.equal(pairStarts, 3);
            assert.deepEqual((await fs.readdir(path.dirname(installDirectory))).filter(name => name.startsWith('.neurocenter-previous.')).sort(), beforeBackups);
        } finally { await fs.writeFile(manifest, original); }
    });
    await check('Небезопасная регистрация отклоняется до замены даже несовместимого прежнего runtime', async () => {
        const manifest = path.join(installDirectory, 'package.json'); const installed = JSON.parse(await fs.readFile(manifest, 'utf8'));
        // Старую версию имитирует только манифест одноразовой установки, исходный архив не меняется.
        await fs.writeFile(manifest, JSON.stringify({ ...installed, version: incompatibleVersion }));
        const sentinel = 'fixture-incompatible-previous.txt'; await fs.writeFile(path.join(installDirectory, sentinel), 'Несовместимую предыдущую установку сохранить');
        const oldManifest = await fs.readFile(manifest, 'utf8'); const oldEntry = digest(await fs.readFile(entry));
        const savedConfig = config + '.saved-fixture'; await fs.rename(config, savedConfig); await fs.mkdir(config);
        const rejected = await installer(env, script); assert.notEqual(rejected.code, 0, rejected.output);
        assert.ok(rejected.output.includes('Не удалось проверить существующую регистрацию MCP'), rejected.output);
        assert.equal(await fs.readFile(manifest,'utf8'),oldManifest);
        assert.equal(digest(await fs.readFile(entry)),oldEntry);
        assert.equal(await fs.readFile(path.join(installDirectory,sentinel),'utf8'),'Несовместимую предыдущую установку сохранить');
        assert.equal((await fs.lstat(config)).isDirectory(), true); assert.deepEqual(await fs.readdir(config), []);
        assert.equal(await fs.readFile(savedConfig, 'utf8'), installedConfig); assert.equal(pairStarts, 3);
        assert.equal((await fs.readdir(path.dirname(installDirectory))).filter(name=>name.startsWith('.neurocenter-previous.')).length,0);
    });
} catch (error) { fatal = error.stack || String(error); console.error(fatal); process.exitCode = 1; }
finally {
    if (child) child.kill('SIGTERM');
    if (process.platform === 'linux') {
        const pids = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name)).map(Number);
        for (const pid of pids) {
            if (await ownsLinuxFixtureProcess(pid, ['--worker', '--pair-watch'])) {
                try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            }
        }
        await waitFor(async () => !(await Promise.all(pids.map(pid => ownsLinuxFixtureProcess(pid, ['--worker', '--pair-watch'])))).some(Boolean),
            'завершение worker и pair-watch одноразового профиля');
    } else {
        const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
        for (const line of processes) {
            const match = /^\s*(\d+)\s+(.+)$/.exec(line);
            if (match && match[2].includes(entry) && /--(worker|pair-watch)(?:\s|$)/.test(match[2])) {
                try { process.kill(Number(match[1]), 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            }
        }
    }
    await delay(200);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(path.dirname(process.env.BRIDGE_NATIVE_REPORT || path.join(root, '.run/bridge-validation', bridgeVersion, 'native-installer.json')), {recursive:true});
    await fs.writeFile(process.env.BRIDGE_NATIVE_REPORT || path.join(root, '.run/bridge-validation', bridgeVersion, 'native-installer.json'), JSON.stringify({ checkedAt: new Date().toISOString(), target, bridgeVersion, buildId: metadata.buildId, archiveSha256: metadata.sha256, cases,
        fatal: fatal || null, installerFailure: installerFailure || null, noSystemNodeOrNpm: true, pairingServer: 'fixture', realBrowserOpened: false,
        temporaryProfileRemoved: true, realProfileChanged: false }, null, 2) + '\n');
}
