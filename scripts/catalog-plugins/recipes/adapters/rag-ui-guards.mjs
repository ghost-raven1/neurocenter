import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { enterManagedSession, leaveManagedSessions } from './rag-index-lock.mjs';

let writer;
let closing = false;
let reindex;
const conflict = () => Object.assign(new Error('Индекс открыт в OpenCode, MCP или другой операции. Обзор доступен; для изменения закройте активную сессию и повторите действие.'), { statusCode: 409 });

/** UI читает параллельно, а изменения используют ту же эксклюзивную блокировку, что плагин. */
export async function withManagedUiMutation(storePath, work) {
    if (closing) throw Object.assign(new Error('OpenCodeRAG UI закрывается. Дождитесь завершения операции и откройте окно заново.'), { statusCode: 503 });
    if (writer?.workFinished) await writer.done;
    if (closing) throw Object.assign(new Error('OpenCodeRAG UI закрывается. Дождитесь завершения операции и откройте окно заново.'), { statusCode: 503 });
    if (writer) { throw conflict(); }
    let completed;
    const state = { abort: new AbortController(), done: new Promise(resolve => { completed = resolve; }) };
    writer = state;
    try {
        try { await enterManagedSession(storePath); }
        catch (error) {
            if (!error.code) { throw conflict(); }
            throw Object.assign(new Error('Не удалось защитить изменение индекса. Проверьте доступ к папке проекта.'), { statusCode: 503 });
        }
        state.abort.signal.throwIfAborted();
        return await work(state.abort.signal);
    } finally {
        state.workFinished = true;
        try { await leaveManagedSessions(); }
        finally { if (writer === state) { writer = undefined; } completed(); }
    }
}

/** Завершение UI ждёт остановки записи, прежде чем освободить presence для восстановления. */
export async function closeManagedUiMutations({ shutdown = false } = {}) {
    if (shutdown) closing = true;
    const current = writer;
    current?.abort.abort();
    await current?.done;
}

export function managedUiRequests(handler, { root, storePath, configPath }) {
    return async (request, response) => {
        let url;
        try { url = new URL(request.url || '/', 'http://127.0.0.1'); }
        catch { response.writeHead(400); response.end(); return true; }
        try {
            if (url.pathname === '/api/file') {
                const { checkedWorkspacePath } = await import('./rag-context.mjs');
                await checkedWorkspacePath(root, url.searchParams.get('path') || '');
            }
            const mutation = request.method === 'PUT' && url.pathname === '/api/config'
                || request.method === 'DELETE' && /^\/api\/(?:quirks|eval\/sessions)\//.test(url.pathname);
            if (mutation) {
                if (configPath && url.pathname === '/api/config') {
                    const { checkedWorkspacePath } = await import('./rag-context.mjs');
                    await checkedWorkspacePath(root, configPath);
                }
                return await withManagedUiMutation(storePath, () => handler(request, response));
            }
            return await handler(request, response);
        } catch (error) {
            if (!response.headersSent) {
                response.writeHead(error.statusCode || 403, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: error.statusCode ? error.message : 'Путь данных выходит за пределы связанной папки или содержит ссылку.' }));
            } else { response.end(); }
            return true;
        }
    };
}

/** Явное редактирование области индекса не может вывести запись за пределы проекта. */
export async function checkedUiConfigPatch(root, configPath, body) {
    const { checkedWorkspacePath } = await import('./rag-context.mjs');
    if (configPath) { await checkedWorkspacePath(root, configPath); }
    if (!Array.isArray(body?.indexing?.includeDirs)) return;
    for (const value of body.indexing.includeDirs) {
        if (typeof value !== 'string' || path.isAbsolute(value)) { throw new Error('Область индексирования должна оставаться в папке проекта.'); }
        await checkedWorkspacePath(root, value);
    }
}

/** Чтение статуса не проверяет модель и не выдаёт отсутствие индекса за актуальность. */
export function managedUiIndexingStatus(response, storePath) {
    if (response.status !== 200) return response;
    const body = response.body;
    return { ...response, body: { ...body,
        freshness: !body.manifest?.lastIndexedAt ? 'never' : body.staleFileCount > 0 ? 'changed' : 'indexed-files-unchanged',
        reindex: reindex?.storePath === storePath ? structuredClone(reindex.status) : null,
    } };
}

function indexProgress(root, status) {
    const completed = new Set(), failed = new Set();
    const progress = status.progress = { totalFiles: null, completedFiles: 0, failedFiles: 0, currentFile: null };
    return {
        setFileCount(count) { if (Number.isSafeInteger(count) && count >= 0) progress.totalFiles = count; },
        startFile(label) {
            const relative = path.relative(root, path.resolve(root, label));
            progress.currentFile = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null;
        },
        finishStage() {},
        finishFile(label) { completed.add(label); progress.completedFiles = completed.size; },
        failFile(label) { failed.add(label); progress.failedFiles = failed.size; },
    };
}

/** Ответ started возвращается только после захвата блокировки; она остаётся до завершения прохода. */
export async function managedUiReindex(options) {
    let accepted;
    let status, signal;
    const started = new Promise(resolve => { accepted = resolve; });
    const work = withManagedUiMutation(options.storePath, async abortSignal => {
        signal = abortSignal;
        status = { id: randomUUID(), state: 'starting', startedAt: new Date().toISOString(), finishedAt: null, error: null };
        reindex = { storePath: options.storePath, status };
        const progress = indexProgress(options.cwd, status);
        const embedder = await options.getEmbedder?.();
        abortSignal.throwIfAborted();
        if (!embedder) { throw new Error('Провайдер эмбеддингов недоступен.'); }
        status.state = 'running';
        accepted({ status: 200, body: { started: true, runId: status.id } });
        const stats = await options.runIndexPass({ cwd: options.cwd, storePath: options.storePath, config: options.cfg, store: options.store, embedder,
            dimension: options.cfg.embedding.vectorDimension, abortSignal, progress });
        abortSignal.throwIfAborted();
        if (!stats || stats.skipped || stats.embeddingUnavailable || stats.embeddingFailures > 0 || stats.extractionFailures > 0 || stats.descriptionFailedFiles > 0) {
            throw new Error('Индексирование не завершено полностью.');
        }
        status.state = 'complete';
    }).catch(error => {
        if (status) {
            status.state = signal.aborted ? 'cancelled' : 'failed';
            status.error = signal.aborted ? 'Индексирование отменено. Повторите действие после открытия UI.'
                : 'Индексирование не завершено. Проверьте модель, область индексирования и состояние локального индекса, затем повторите.';
        }
        accepted({ status: error.statusCode || 503, body: { error: error.statusCode ? error.message : 'Индексирование не выполнено. Проверьте модель и состояние локального индекса.' } });
    }).finally(() => {
        if (status) { status.finishedAt = new Date().toISOString(); status.progress.currentFile = null; }
        // Cache invalidation must not turn an already recorded terminal outcome into an unhandled rejection.
        try { options.onFinished(); } catch { }
    });
    void work;
    return started;
}
