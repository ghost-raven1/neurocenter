import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, readState, stateDir } from '../src/bridge/state.js';
import { ensureCurrentWorker, finishWorkerUpgrade, prepareWorkerUpgrade, waitForWorkerInstallation } from '../src/bridge/worker-upgrade.js';
import { BRIDGE_VERSION, bridgeBuildId } from '../src/bridge/protocol.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: execute }) }));
vi.mock('../src/bridge/state.js', () => ({ api: vi.fn(), readState: vi.fn(), stateDir: vi.fn() }));
vi.mock('../src/bridge/protocol.js', () => ({ BRIDGE_VERSION: 'test-version', bridgeBuildId: vi.fn(async () => 'same-build') }));

describe('Безопасная подготовка замены установленного worker', () => {
    let directory: string;
    let lock: string;
    let stopped: boolean;
    let signals: Array<string | number | undefined>;
    const pid = 1234567;
    const installed = path.join(os.tmpdir(), 'установленный мост', 'dist', 'index.js');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    beforeEach(async () => {
        vi.resetAllMocks();
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-worker-upgrade-'));
        lock = path.join(directory, 'worker.lock');
        vi.mocked(stateDir).mockReturnValue(directory);
        vi.mocked(bridgeBuildId).mockResolvedValue('same-build');
        vi.mocked(readState).mockResolvedValue({ pid, version: BRIDGE_VERSION, buildId: 'same-build' });
        vi.mocked(api).mockResolvedValue({ activeJobs: 0 });
        stopped = false; signals = [];
        vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
            signals.push(signal);
            if (signal === 'SIGTERM') { stopped = true; return true; }
            if (stopped) { throw Object.assign(new Error('Отсутствует'), { code: 'ESRCH' }); }
            return true;
        });
        execute.mockResolvedValue({ stdout: `${process.getuid?.()} ${process.execPath} "${installed}" --worker\n` });
        await fs.writeFile(lock, String(pid));
    });
    afterEach(async () => {
        Object.defineProperty(process, 'platform', platform);
        vi.useRealTimers(); vi.restoreAllMocks();
        await fs.rm(directory, { recursive: true, force: true });
    });
    it('Та же сборка останавливается, а пауза удерживается до завершения замены файлов', async () => {
        await prepareWorkerUpgrade(installed);
        expect(signals.filter(signal => signal === 'SIGTERM')).toHaveLength(1);
        expect(vi.mocked(api).mock.calls.map(call => call[0])).toEqual(['worker/pause']);
        await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
        await finishWorkerUpgrade();
        expect(api).toHaveBeenLastCalledWith('worker/resume');
    });
    it('Обычное подключение сохраняет worker той же версии и сборки', async () => {
        await ensureCurrentWorker();
        expect(api).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
        expect(signals).not.toContain('SIGTERM');
    });
    it('Обычное подключение другой сборки возобновляет очередь после остановки', async () => {
        vi.mocked(bridgeBuildId).mockResolvedValue('another-build');
        const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
        execute.mockResolvedValue({ stdout: `${process.getuid?.()} node ${entry} --worker` });
        await ensureCurrentWorker();
        expect(vi.mocked(api).mock.calls.map(call => call[0])).toEqual(['worker/pause', 'worker/resume']);
    });
    it('Worker из staging не совпадает с переданным установленным entry', async () => {
        const staging = fileURLToPath(new URL('../src/index.js', import.meta.url));
        execute.mockResolvedValue({ stdout: `${process.getuid?.()} ${process.execPath} ${staging} --worker` });
        await expect(prepareWorkerUpgrade(installed)).rejects.toThrow('другому процессу');
        expect(signals).not.toContain('SIGTERM'); expect(api).toHaveBeenLastCalledWith('worker/resume');
    });
    it.each(['чужой пользователь', 'другой полный путь'])('Не завершает процесс: %s', async reason => {
        execute.mockResolvedValue({ stdout: reason === 'чужой пользователь'
            ? `${(process.getuid?.() || 0) + 1} node "${installed}" --worker`
            : `${process.getuid?.()} node /подмена${installed} --worker` });
        await expect(prepareWorkerUpgrade(installed)).rejects.toThrow('другому процессу');
        expect(signals).not.toContain('SIGTERM'); expect(api).toHaveBeenLastCalledWith('worker/resume');
    });
    it('Изменённая блокировка проверяется повторно после проверки процесса', async () => {
        execute.mockImplementation(async () => {
            await fs.writeFile(lock, String(pid + 1));
            return { stdout: `${process.getuid?.()} node "${installed}" --worker` };
        });
        await expect(prepareWorkerUpgrade(installed)).rejects.toThrow('блокировки MCP изменился');
        expect(signals).not.toContain('SIGTERM'); expect(await fs.readFile(lock, 'utf8')).toBe(String(pid + 1));
        expect(api).toHaveBeenLastCalledWith('worker/resume');
    });
    it('Незавершённое задание откладывает обновление без SIGTERM и возвращает очередь', async () => {
        vi.mocked(api).mockResolvedValue({ activeJobs: 1 });
        vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(30000);
        await expect(prepareWorkerUpgrade(installed)).rejects.toThrow('незавершённое задание');
        expect(signals).not.toContain('SIGTERM'); expect(execute).not.toHaveBeenCalled();
        expect(api).toHaveBeenLastCalledWith('worker/resume');
    });
    it('Недоступный API живого worker останавливает установку и пытается вернуть очередь', async () => {
        vi.mocked(api).mockRejectedValue(new Error('Недоступен API'));
        await expect(prepareWorkerUpgrade(installed)).rejects.toThrow('Недоступен API');
        expect(signals).not.toContain('SIGTERM'); expect(api).toHaveBeenLastCalledWith('worker/resume');
    });
    it('Отсутствие worker и локальных ключей не требует API', async () => {
        await fs.rm(lock); vi.mocked(readState).mockResolvedValue(undefined);
        await prepareWorkerUpgrade(installed);
        expect(api).not.toHaveBeenCalled(); expect(process.kill).not.toHaveBeenCalled();
    });
    it('Сохранённое подключение ставит паузу даже без worker.lock', async () => {
        await fs.rm(lock);
        await prepareWorkerUpgrade(installed);
        expect(vi.mocked(api).mock.calls.map(call => call[0])).toEqual(['worker/pause']);
        expect(process.kill).not.toHaveBeenCalled();
        await finishWorkerUpgrade();
        expect(api).toHaveBeenLastCalledWith('worker/resume');
    });
    it('Завершение установки без ключей не обращается к API', async () => {
        vi.mocked(readState).mockResolvedValue(undefined);
        await finishWorkerUpgrade(); expect(api).not.toHaveBeenCalled();
    });
    it('Ошибка завершения паузы не скрывается от установщика', async () => {
        vi.mocked(api).mockRejectedValue(new Error('Недоступен API'));
        await expect(finishWorkerUpgrade()).rejects.toThrow('Недоступен API');
    });
    it('Неверный абсолютный путь отвергается до чтения состояния', async () => {
        await expect(prepareWorkerUpgrade('dist/index.js')).rejects.toThrow('абсолютный путь');
        expect(process.kill).not.toHaveBeenCalled(); expect(api).not.toHaveBeenCalled();
    });
    it('На Windows требуется SID текущего пользователя', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        execute.mockResolvedValue({ stdout: JSON.stringify({ owned: false, commandLine: `node "${installed}" --worker` }) });
        await expect(prepareWorkerUpgrade(installed)).rejects.toThrow('другому процессу');
        expect(execute.mock.calls[0]?.[1]?.join(' ')).toContain('GetOwnerSid');
        expect(signals).not.toContain('SIGTERM'); expect(api).toHaveBeenLastCalledWith('worker/resume');
    });
    it('Новый worker ждёт удаления блокировки установщика', async () => {
        const entry = path.join(directory, 'installed', 'dist', 'index.js');
        const installationLock = path.join(directory, 'installed.install-lock');
        await fs.mkdir(installationLock);
        const stat = vi.spyOn(fs, 'lstat');
        let finished = false;
        const waiting = waitForWorkerInstallation(entry).then(result => { finished = true; return result; });
        await vi.waitFor(() => expect(stat).toHaveBeenCalledWith(installationLock));
        expect(finished).toBe(false); expect(api).not.toHaveBeenCalled();
        await fs.rm(installationLock, { recursive: true });
        await expect(waiting).resolves.toBe(true);
    });
    it('Зависшая блокировка прекращает запуск через 60 секунд без операций', async () => {
        const entry = path.join(directory, 'installed', 'dist', 'index.js');
        await fs.mkdir(path.join(directory, 'installed.install-lock'));
        vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(60000);
        await expect(waitForWorkerInstallation(entry)).resolves.toBe(false);
        expect(readState).not.toHaveBeenCalled(); expect(api).not.toHaveBeenCalled();
    });
});
