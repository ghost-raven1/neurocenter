import { spawn, type ChildProcess } from 'node:child_process';
import { ragUiReady } from './contract.js';

interface StopOptions {
    force?: boolean;
    timeoutMs?: number;
}
export interface UiProcess {
    child: ChildProcess;
    url: string;
    stop(options?: StopOptions): Promise<void>;
}
/** Долгоживущий HTTP-процесс принадлежит worker; URL читается только из IPC и не печатается. */
export async function startRagUiProcess(
    entrypoint: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
): Promise<UiProcess> {
    const child = spawn(process.execPath, [entrypoint, ...args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let ended = false;
    const hasExited = () => ended || child.exitCode != null || child.signalCode != null;
    let outputBytes = 0;
    const drain = (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 1024 * 1024) void stop();
    };
    child.stdout?.on('data', drain);
    child.stderr?.on('data', drain);
    child.on('error', () => {});
    // exit подтверждает смерть PID; close может задержаться из-за унаследованных другим процессом pipes.
    const onEnded = () => {
        if (ended) return;
        ended = true;
        child.off('exit', onEnded);
        child.off('close', onEnded);
        child.stdout?.off('data', drain);
        child.stderr?.off('data', drain);
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (child.connected) child.disconnect();
    };
    child.once('exit', onEnded);
    child.once('close', onEnded);
    let stopping: Promise<void> | undefined;
    const close = async (force: boolean, timeoutMs: number) => {
        if (hasExited()) {
            onEnded();
            return;
        }
        if (child.connected) child.disconnect();
        if (hasExited()) {
            onEnded();
            return;
        }
        await new Promise<void>((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                child.off('exit', finish);
                child.off('close', finish);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            timer.unref();
            child.once('exit', finish);
            child.once('close', finish);
            if (hasExited()) finish();
        });
        if (hasExited()) {
            onEnded();
            return;
        }
        if (!force)
            throw new Error(
                'Интерфейс завершает текущую работу с индексом. Дождитесь её окончания и повторите восстановление.',
            );
        if (child.pid) {
            try {
                if (process.platform === 'win32') child.kill('SIGKILL');
                else process.kill(-child.pid, 'SIGKILL');
            } catch {
                /* Уже завершён только наш процесс. */
            }
        }
    };
    const stop = (options: StopOptions = {}): Promise<void> => {
        if (stopping)
            return options.force === false
                ? stopping
                : stopping.catch(() => {
                      stopping = undefined;
                      return stop(options);
                  });
        const task = close(options.force !== false, options.timeoutMs ?? 1200);
        stopping = task;
        void task.catch(() => {
            if (stopping === task) stopping = undefined;
        });
        return task;
    };
    try {
        const ready = await new Promise<{ url: string; port: number }>((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('Интерфейс OpenCodeRAG не запустился за отведённое время.'));
            }, 20000);
            const fail = () => {
                cleanup();
                reject(new Error('Локальный интерфейс OpenCodeRAG завершился до готовности.'));
            };
            const message = (value: unknown) => {
                try {
                    const result = ragUiReady(value);
                    cleanup();
                    resolve(result);
                } catch {
                    cleanup();
                    reject(new Error('Локальный интерфейс не подтвердил безопасную готовность.'));
                }
            };
            const cleanup = () => {
                clearTimeout(timer);
                child.off('message', message);
                child.off('error', fail);
                child.off('exit', fail);
                child.off('close', fail);
            };
            child.on('message', message);
            child.once('error', fail);
            child.once('exit', fail);
            child.once('close', fail);
        });
        return { child, url: ready.url, stop };
    } catch (error) {
        await stop();
        throw error;
    }
}
