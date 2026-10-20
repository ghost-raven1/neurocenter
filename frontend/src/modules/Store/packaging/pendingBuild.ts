import { isAxiosError } from 'axios';
import type { ToolBuild } from './types';
import { readBuildCheckpoint, saveBuildCheckpoint } from './buildRecovery';

export class BuildRequestUnresolvedError extends Error {
    constructor() {
        super('Сервер ещё не подтвердил запрос. Можно проверить его снова или повторить отправку с тем же ключом, без второй сборки.');
        this.name = 'BuildRequestUnresolvedError';
    }
}
interface SubmissionRequest {signature: string; key: string}
/** Неизвестный исход разрешает повтор только с восстановленным точным телом. */
export function buildSubmissionRequest(signature: string, previous?: SubmissionRequest, retainedKey?: string): SubmissionRequest {
    if (retainedKey) {
        if(previous?.key!==retainedKey||previous.signature!==signature)throw new Error('Нельзя изменить сохранённый запрос упаковки под прежним UUID.');
        return previous;
    }
    return previous?.signature === signature ? previous : {signature, key: crypto.randomUUID()};
}
export function readPendingBuild(scope: string): string | undefined {
    return readBuildCheckpoint(scope, 'request');
}
/** Здесь только навигационный UUID; точное тело отдельно фиксируется в IndexedDB. */
export function savePendingBuild(scope: string, key?: string): void {
    if (!saveBuildCheckpoint(scope, 'request', key) && key) throw new Error('Не удалось сохранить ключ сборки. Отправка остановлена. Разрешите хранение данных сайта в настройках браузера и повторите.');
}
function pause(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = (): void => { clearTimeout(timer); reject(new DOMException('Запрос отменён.', 'AbortError')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 2000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
}

/** После неизвестного результата POST разрешены только GET; автоматического повторного enqueue нет. */
export async function resumePendingBuild(key: string, read: (key: string, signal?: AbortSignal) => Promise<ToolBuild>, signal: AbortSignal,
    onRetry: (cause: unknown) => void = () => {}): Promise<ToolBuild> {
    const deadline = Date.now() + 45_000;
    const controller = new AbortController();
    let expired = false;
    const abort = (): void => controller.abort();
    const timer = setTimeout(() => { expired = true; abort(); }, Math.max(0, deadline - Date.now()));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
        while (!controller.signal.aborted) {
            if (Date.now() >= deadline) { expired = true; break; }
            try { const result = await pendingRead(key, read, controller.signal); if (controller.signal.aborted) break; return result; }
            catch (cause) {
                if (controller.signal.aborted) break;
                const status = isAxiosError(cause) ? cause.response?.status : undefined;
                if (status !== undefined && status !== 404 && status < 500) throw cause;
                onRetry(cause);
                try { await pause(controller.signal); } catch (error) { if (!controller.signal.aborted) throw error; }
            }
        }
        throw expired ? new BuildRequestUnresolvedError() : new DOMException('Запрос отменён.', 'AbortError');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

/** Deadline освобождает ожидание даже у transport, который проигнорировал отмену. */
async function pendingRead(key: string, read: (key: string, signal?: AbortSignal) => Promise<ToolBuild>, signal: AbortSignal): Promise<ToolBuild> {
    if (signal.aborted) throw new DOMException('Запрос отменён.', 'AbortError');
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new DOMException('Запрос отменён.', 'AbortError')); signal.addEventListener('abort', abort, { once: true }); });
    try { return await Promise.race([read(key, signal), cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
}

export function acceptBuildProgress(previous: ToolBuild | undefined, next: ToolBuild): ToolBuild {
    if (previous?.id !== next.id) return next;
    if (['SUCCEEDED', 'FAILED'].includes(previous.state) || previous.state === 'RUNNING' && next.state === 'QUEUED') return previous;
    return { ...next, percent: Math.max(previous.percent, next.percent) };
}
