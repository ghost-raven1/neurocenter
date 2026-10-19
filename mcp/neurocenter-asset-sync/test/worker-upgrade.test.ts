import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
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
        Object.defineProperty(process, 'platform', { value: 'darwin' });
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
        vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
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
        await expect(prepareWorkerUpgrade(installed)).resolves.toEqual({ paused: false });
        expect(api).not.toHaveBeenCalled(); expect(process.kill).not.toHaveBeenCalled();
    });
    it('Сохранённое подключение ставит паузу даже без worker.lock', async () => {
        await fs.rm(lock);
        await expect(prepareWorkerUpgrade(installed)).resolves.toEqual({ paused: true });
        expect(vi.mocked(api).mock.calls.map(call => call[0])).toEqual(['worker/pause']);
        expect(process.kill).not.toHaveBeenCalled();
        await finishWorkerUpgrade();
        expect(api).toHaveBeenLastCalledWith('worker/resume');
    });
    it.each(['отсутствует', 'завершён'])('Сверка сервера не блокирует установку, когда worker %s; локальные результаты сохранены', async owner => {
        if (owner === 'отсутствует') { await fs.rm(lock); }
        else { stopped = true; }
        const completion = path.join(directory, 'completions', 'saved.json');
        const journal = path.join(directory, 'workspace-identity-pending.json');
        await fs.mkdir(path.dirname(completion));
        await fs.writeFile(completion, 'сохранённое подтверждение');
        await fs.writeFile(journal, 'сохранённый журнал');
        vi.mocked(api).mockResolvedValue({ activeJobs: 1 });
        vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(30000);
        await expect(prepareWorkerUpgrade(installed)).resolves.toEqual({ paused: true });
        expect(vi.mocked(api).mock.calls.map(call => call[0])).toEqual(['worker/pause']);
        expect(signals).not.toContain('SIGTERM'); expect(execute).not.toHaveBeenCalled();
        await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readFile(completion, 'utf8')).toBe('сохранённое подтверждение');
        expect(await fs.readFile(journal, 'utf8')).toBe('сохранённый журнал');
    });
    it.each([401, 403])('Отказ HTTP %s без worker позволяет перейти к восстановлению подключения', async status => {
        await fs.rm(lock);
        vi.mocked(api).mockRejectedValue(Object.assign(new Error('Подключение недействительно'), { status }));
        await expect(prepareWorkerUpgrade(installed)).resolves.toEqual({ paused: false });
        expect(vi.mocked(api).mock.calls.map(call => call[0])).toEqual(['worker/pause']);
        expect(process.kill).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    });
    it('Подмена завершённого PID не удаляет блокировку нового worker', async () => {
        vi.mocked(process.kill).mockImplementationOnce(() => {
            writeFileSync(lock, String(pid + 1));
            throw Object.assign(new Error('Отсутствует'), { code: 'ESRCH' });
        });
        await expect(prepareWorkerUpgrade(installed)).rejects.toThrow('блокировки MCP изменился');
        expect(await fs.readFile(lock, 'utf8')).toBe(String(pid + 1));
        expect(api).not.toHaveBeenCalled(); expect(signals).not.toContain('SIGTERM');
    });
    it.each([200, 401, 403])('Новый worker во время HTTP %s останавливает подготовку и сохраняет новую блокировку', async status => {
        await fs.rm(lock);
        vi.mocked(api).mockImplementation(async route => {
            if (route === 'worker/pause') {
                await fs.writeFile(lock, String(pid + 1));
                if (status !== 200) { throw Object.assign(new Error('Подключение недействительно'), { status }); }
                return { activeJobs: 1 };
            }
            return { ok: true };
        });
        await expect(prepareWorkerUpgrade(installed)).rejects.toThrow('блокировки MCP изменился');
        expect(await fs.readFile(lock, 'utf8')).toBe(String(pid + 1));
        expect(process.kill).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
        expect(vi.mocked(api).mock.calls.map(call => call[0])).toEqual(status === 200
            ? ['worker/pause', 'worker/resume'] : ['worker/pause']);
    });
    it.each([401, 403])('Отказ HTTP %s живого worker сохраняет запрет обновления', async status => {
        vi.mocked(api).mockRejectedValue(Object.assign(new Error('Подключение недействительно'), { status }));
        await expect(prepareWorkerUpgrade(installed)).rejects.toThrow('Подключение недействительно');
        expect(signals).not.toContain('SIGTERM'); expect(await fs.readFile(lock, 'utf8')).toBe(String(pid));
    });
    it.each([Object.assign(new Error('Сервис недоступен'), { status: 503 }), new Error('Сеть недоступна')])('Сбой связи без worker не разрешает замену: %s', async error => {
        await fs.rm(lock); vi.mocked(api).mockRejectedValue(error);
        await expect(prepareWorkerUpgrade(installed)).rejects.toBe(error);
        expect(process.kill).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
        expect(api).toHaveBeenLastCalledWith('worker/resume');
    });
    it.each([undefined, null, {}, { activeJobs: -1 }, { activeJobs: '1' }])('Неподтверждённая очередь без worker останавливает установку: %j', async response => {
        await fs.rm(lock); vi.mocked(api).mockResolvedValue(response);
        await expect(prepareWorkerUpgrade(installed)).rejects.toThrow('Сервер не подтвердил состояние очереди');
        expect(api).toHaveBeenLastCalledWith('worker/resume');
        expect(process.kill).not.toHaveBeenCalled();
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
    it('На Linux путь с кириллицей проверяется через procfs даже при LC_ALL=C и отсутствующем LANG', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        vi.stubEnv('LANG', undefined); vi.stubEnv('LC_ALL', 'C');
        const owner = vi.spyOn(fs, 'stat').mockResolvedValueOnce({ uid: process.getuid?.() } as Awaited<ReturnType<typeof fs.stat>>);
        const command = vi.spyOn(fs, 'readFile').mockResolvedValueOnce(`${process.execPath}\0${installed}\0--worker\0`);
        execute.mockRejectedValue(new Error('ps заменяет кириллицу при C locale'));
        await expect(prepareWorkerUpgrade(installed)).resolves.toEqual({ paused: true });
        expect(owner).toHaveBeenCalledWith(`/proc/${pid}`);
        expect(command).toHaveBeenCalledWith(`/proc/${pid}/cmdline`, 'utf8');
        expect(execute).not.toHaveBeenCalled();
        expect(signals.filter(signal => signal === 'SIGTERM')).toHaveLength(1);
        await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it.each([
        ['--no-opt', '-r', '/proc/.reset'],
        ['--enable-source-maps'],
    ])('Linux допускает параметры запуска Node перед установленным worker: %j', async (...prefix) => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        vi.stubEnv('LANG', undefined); vi.stubEnv('LC_ALL', 'C');
        vi.spyOn(fs, 'stat').mockResolvedValueOnce({ uid: process.getuid?.() } as Awaited<ReturnType<typeof fs.stat>>);
        vi.spyOn(fs, 'readFile').mockResolvedValueOnce([process.execPath, ...prefix, installed, '--worker', ''].join('\0'));
        await expect(prepareWorkerUpgrade(installed)).resolves.toEqual({ paused: true });
        expect(signals.filter(signal => signal === 'SIGTERM')).toHaveLength(1);
        expect(execute).not.toHaveBeenCalled();
        await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it.each([
        { reason: 'чужой UID', owner: (process.getuid?.() || 0) + 1, args: ['node', installed, '--worker'] },
        { reason: 'другой entry', args: ['node', '/подмена' + installed, '--worker'] },
        { reason: 'путь и флаг в одном аргументе', args: ['node', installed + ' --worker'] },
        { reason: 'другой флаг', args: ['node', installed, '--worker-other'] },
        { reason: 'entry в аргументах node --eval', args: ['node', '--eval', 'setInterval(()=>{},1000)', installed, '--worker'] },
        ...['--eval=0', '--print', '--print=0', '-e', '-p', '-e0', '-p0', '-pe', '-ep', '-ie'].map(flag => ({
            reason: `entry после параметра ${flag}`, args: ['node', flag, installed, '--worker'],
        })),
        { reason: 'дополнительный аргумент после --worker', args: ['node', installed, '--worker', 'другой аргумент'] },
    ])('Linux сохраняет чужой процесс: $reason', async ({ owner, args }) => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        vi.spyOn(fs, 'stat').mockResolvedValueOnce({ uid: owner ?? process.getuid?.() } as Awaited<ReturnType<typeof fs.stat>>);
        vi.spyOn(fs, 'readFile').mockResolvedValueOnce(args.join('\0') + '\0');
        await expect(prepareWorkerUpgrade(installed)).rejects.toThrow('другому процессу');
        expect(signals).not.toContain('SIGTERM'); expect(execute).not.toHaveBeenCalled();
        expect(api).toHaveBeenLastCalledWith('worker/resume');
        expect(await fs.readFile(lock, 'utf8')).toBe(String(pid));
    });
    it.each(['EACCES', 'ENOENT'])('Linux не завершает процесс, если cmdline недоступен: %s', async code => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        vi.spyOn(fs, 'stat').mockResolvedValueOnce({ uid: process.getuid?.() } as Awaited<ReturnType<typeof fs.stat>>);
        vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('procfs недоступен'), { code }));
        await expect(prepareWorkerUpgrade(installed)).rejects.toThrow('другому процессу');
        expect(signals).not.toContain('SIGTERM'); expect(execute).not.toHaveBeenCalled();
        expect(api).toHaveBeenLastCalledWith('worker/resume');
        expect(await fs.readFile(lock, 'utf8')).toBe(String(pid));
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
    it.each([401, 403, 503])('API сохраняет HTTP %s отдельно от сообщения ошибки', async status => {
        vi.stubEnv('NEUROCENTER_BRIDGE_HOME', directory); vi.stubEnv('NEUROCENTER_URL', 'http://127.0.0.1:1');
        const fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'Исходная причина отказа' }), { status }));
        vi.stubGlobal('fetch', fetch);
        const actual = await vi.importActual<typeof import('../src/bridge/state.js')>('../src/bridge/state.js');
        await expect(actual.api('worker/pause')).rejects.toMatchObject({ message: 'Исходная причина отказа', status });
        expect(fetch).toHaveBeenCalledOnce();
    });
});
