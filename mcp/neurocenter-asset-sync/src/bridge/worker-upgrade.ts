import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { api, readState, stateDir, type Credentials } from './state.js';
import { BRIDGE_VERSION, bridgeBuildId } from './protocol.js';
import { readBoundedUtf8 } from './read-bounded.js';

const exec = promisify(execFile);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { return false; } throw error; }
}
async function readLock(lock: string): Promise<string> {
    return readBoundedUtf8(lock, 4096).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') { return ''; } throw error;
    });
}
/** Проверяем владельца ОС и отдельный аргумент установленного entry перед сигналом процессу. */
async function assertWorker(pid: number, index: string): Promise<void> {
    const refusal = 'PID блокировки принадлежит другому процессу. Обновление остановлено без завершения этого процесса.';
    if (process.platform === 'linux') {
        // procfs сохраняет UTF-8 и границы аргументов независимо от LANG/LC_ALL вызывающего shell.
        const verified = await Promise.all([fs.stat(`/proc/${pid}`), fs.readFile(`/proc/${pid}/cmdline`, 'utf8')])
            .then(([owner, command]) => {
                const args = command.replace(/\0$/, '').split('\0');
                const evaluation = args.slice(1, -2).some(argument => /^(?:--(?:eval|print)(?:=|$)|-[^-]*[ep])/.test(argument));
                return Number.isSafeInteger(process.getuid?.()) && owner.uid === process.getuid?.()
                    && args.at(-2) === index && args.at(-1) === '--worker' && !evaluation;
            }, () => false);
        if (!verified) { throw new Error(refusal); }
        return;
    }
    let command: string; let ownUser: boolean;
    if (process.platform === 'win32') {
        const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
            `$owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; ` +
            `@{owned=($owner.ReturnValue -eq 0 -and $owner.Sid -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value);commandLine=$p.CommandLine}|ConvertTo-Json -Compress`;
        const result = JSON.parse((await exec('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 5000 })).stdout) as { owned?: unknown; commandLine?: unknown };
        ownUser = result.owned === true; command = typeof result.commandLine === 'string' ? result.commandLine : '';
    } else {
        const output = (await exec('ps', ['-p', String(pid), '-o', 'uid=', '-o', 'args='], { timeout: 5000 })).stdout.trim();
        const parts = /^(\d+)\s+([\s\S]*)$/.exec(output);
        ownUser = !!parts && Number(parts[1]) === process.getuid?.(); command = parts?.[2] || '';
    }
    const escaped = index.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const argument = new RegExp(`(?:^|\\s)(?:"${escaped}"|${escaped})\\s+--worker(?:\\s|$)`);
    if (!ownUser || !argument.test(command)) {
        throw new Error(refusal);
    }
}
async function stopWorker(index: string, force: boolean): Promise<boolean> {
    const lock = path.join(stateDir(), 'worker.lock');
    const raw = await readLock(lock);
    let pid: number | undefined;
    if (raw) {
        pid = Number(raw);
        if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) { throw new Error('Повреждена блокировка локального MCP.'); }
        if (!alive(pid)) {
            if (await readLock(lock) !== raw) { throw new Error('Владелец блокировки MCP изменился. Повторите обновление.'); }
            await fs.rm(lock, { force: true });
            pid = undefined;
        }
    }
    if (!pid && (!force || !await readState<Credentials>('credentials'))) { return false; }
    if (!force) {
        const version = await readState<{ pid: number; version: string; buildId?: string }>('worker-version');
        if (version && version.pid === pid && version.version === BRIDGE_VERSION && version.buildId === await bridgeBuildId()) { return false; }
    }
    let paused = false; let completed = false;
    try {
        const until = Date.now() + 30000;
        for (;;) {
            paused = true;
            let status: { activeJobs: number };
            try { status = await api<{ activeJobs: number }>('worker/pause'); }
            catch (error) {
                const denied = (error as { status?: number } | null)?.status;
                if (!pid && (denied === 401 || denied === 403)) {
                    // Без worker недействующий ключ должен дойти до повторного подключения.
                    paused = false;
                    if (await readLock(lock)) { throw new Error('Владелец блокировки MCP изменился. Повторите обновление.'); }
                    return false;
                }
                throw error;
            }
            if (!status || !Number.isSafeInteger(status.activeJobs) || status.activeJobs < 0) { throw new Error('Сервер не подтвердил состояние очереди MCP. Обновление остановлено.'); }
            if (!pid && await readLock(lock)) { throw new Error('Владелец блокировки MCP изменился. Повторите обновление.'); }
            // Серверная сверка переживает процесс: её журналы обработает установленный worker.
            if (!pid || status.activeJobs === 0) { break; }
            if (Date.now() >= until) { throw new Error('Обновление MCP отложено: на компьютере есть незавершённое задание. Дождитесь результата и повторите подключение.'); }
            await wait(500);
        }
        if (pid && alive(pid)) {
            await assertWorker(pid, index);
            if (await readLock(lock) !== raw) { throw new Error('Владелец блокировки MCP изменился. Повторите обновление.'); }
            process.kill(pid, 'SIGTERM');
            const stoppedBy = Date.now() + 5000;
            while (alive(pid)) {
                if (Date.now() >= stoppedBy) { throw new Error('Предыдущий MCP ещё завершается. Повторите подключение через несколько секунд.'); }
                await wait(100);
            }
            if (await readLock(lock) === raw) { await fs.rm(lock, { force: true }); }
        }
        completed = true;
        return paused;
    } finally {
        if (paused && (!force || !completed)) { await api('worker/resume').catch(() => undefined); }
    }
}
/** Обновляем только собственный простаивающий worker; сервер временно приостанавливает выдачу заданий. */
export async function ensureCurrentWorker(): Promise<void> {
    await stopWorker(fileURLToPath(new URL('../index.js', import.meta.url)), false);
}
/** Установщик останавливает старый worker до замены файлов, даже при той же версии сборки. */
export async function prepareWorkerUpgrade(installedEntry: string): Promise<{ paused: boolean }> {
    if (!installedEntry || !path.isAbsolute(installedEntry) || path.normalize(installedEntry) !== installedEntry) {
        throw new Error('Для обновления нужен абсолютный путь установленного dist/index.js.');
    }
    return { paused: await stopWorker(installedEntry, true) };
}
/** Завершаем паузу после размещения файлов либо после отката установщика. */
export async function finishWorkerUpgrade(): Promise<void> {
    if (await readState<Credentials>('credentials')) { await api('worker/resume'); }
}
/** Новый worker ждёт освобождения блокировки установщика до чтения настроек и любых операций. */
export async function waitForWorkerInstallation(installedEntry = fileURLToPath(new URL('../index.js', import.meta.url))): Promise<boolean> {
    const lock = path.dirname(path.dirname(installedEntry)) + '.install-lock';
    const until = Date.now() + 60000;
    while (await fs.lstat(lock).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') { return false; } throw error;
    })) {
        if (Date.now() >= until) { return false; }
        await wait(250);
    }
    return true;
}
