import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { GlobalProviderEditor, GlobalProviderInputError, type CompatibleCliProof } from './editor.js';
import { globalProvidersPage } from './page.js';
import type { GlobalProvidersLimits } from './contract.js';
interface Options {
    id: string;
    home: string;
    environment: NodeJS.ProcessEnv;
    expiresAt: string;
    limits: Readonly<GlobalProvidersLimits>;
    authorize: (signal?: AbortSignal) => Promise<unknown>;
    assertCurrent: () => Promise<void>;
    assertCompatibleCli: (signal?: AbortSignal) => Promise<CompatibleCliProof>;
    open: (url: string) => Promise<boolean>;
}
const active = new Map<string, () => Promise<void>>();
const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
};
async function body(req: IncomingMessage, maximum: number) {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        const value = Buffer.from(chunk);
        if ((bytes += value.length) > maximum) throw Error();
        chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value as Record<string, unknown>;
}
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
/** Single-use fragment, strict loopback Host/Origin, CSP and CSRF mirror the existing private configuration framework. */
export async function startGlobalProvidersSession(options: Options) {
    if (active.has(options.id) || active.size >= options.limits.sessions)
        throw Error('Локальная настройка уже открыта или достигнут лимит окон.');
    await options.authorize();
    await options.assertCurrent();
    const deadline = Math.min(Date.parse(options.expiresAt), Date.now() + options.limits.sessionMs);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw Error('Сессия истекла.');
    const token = randomBytes(32).toString('base64url'),
        csrf = randomBytes(32).toString('base64url'),
        nonce = randomBytes(24).toString('base64url'),
        session = new AbortController(),
        pending = new Set<Promise<void>>();
    let used = false,
        busy = false,
        closed = false;
    const current = () => {
        if (closed || Date.now() >= deadline) throw Error('Сессия истекла.');
    };
    const admit = async () => {
        current();
        await options.assertCurrent();
        await options.authorize(session.signal);
        current();
        await options.assertCurrent();
    };
    const compatible = async () => {
        await admit();
        const proof = await options.assertCompatibleCli(session.signal);
        await admit();
        return {
            assertCurrent: async () => {
                await admit();
                await proof.assertCurrent();
                await admit();
            },
        };
    };
    const editor = new GlobalProviderEditor({
        home: options.home,
        environment: options.environment,
        limits: options.limits,
        authorize: admit,
        current,
        assertCompatibleCli: compatible,
    });
    const server = createServer((req, res) => {
        let abandoned = false;
        res.once('close', () => {
            if (!res.writableEnded) abandoned = true;
        });
        const task = (async () => {
            current();
            const address = server.address();
            if (!address || typeof address === 'string') throw Error();
            const host = '127.0.0.1:' + address.port,
                origin = 'http://' + host;
            if (
                req.headers.host !== host ||
                !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
            ) {
                json(res, 403, {});
                return;
            }
            if (req.method === 'GET' && req.url === '/') {
                await admit();
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                    'Referrer-Policy': 'no-referrer',
                    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
                });
                res.end(
                    globalProvidersPage
                        .replace('<style>', `<style nonce="${nonce}">`)
                        .replace('<script>', `<script nonce="${nonce}">`),
                );
                return;
            }
            if (
                req.method !== 'POST' ||
                req.headers.origin !== origin ||
                req.headers['content-type'] !== 'application/json'
            ) {
                json(res, 403, {});
                return;
            }
            const value = await body(req, options.limits.requestBytes);
            current();
            if (abandoned) throw Error();
            if (req.url === '/session' && !used && Object.keys(value).length === 1 && value.token === token) {
                used = true;
                await admit();
                json(res, 200, { csrf, expiresAt: new Date(deadline).toISOString() });
                return;
            }
            if (!used || req.headers['x-global-providers-csrf'] !== csrf) {
                json(res, 403, {});
                return;
            }
            if (req.url === '/close' && Object.keys(value).length === 0) {
                json(res, 200, { closed: true });
                void close();
                return;
            }
            if (busy) {
                json(res, 409, { message: 'Дождитесь завершения текущего локального действия.' });
                return;
            }
            busy = true;
            try {
                await admit();
                if (abandoned) throw Error();
                let result: unknown;
                if (req.url === '/inventory' && Object.keys(value).length === 0)
                    result = {
                        inventory: await editor.inventory(),
                        lastSave: await editor.lastSave(),
                        limits: options.limits,
                    };
                else if (
                    req.url === '/prepare' &&
                    exact(value, ['providerId', 'authentication', 'apiKey', 'baseURL', 'modelIds'])
                )
                    result = await editor.prepare(value);
                else if (req.url === '/save' && exact(value, ['previewId'])) result = await editor.save(value);
                else if (req.url === '/resume' && exact(value, ['intentId'])) result = await editor.resume(value);
                else {
                    json(res, 400, {});
                    return;
                }
                current();
                json(res, 200, result);
            } finally {
                busy = false;
            }
        })().catch((error) => {
            const code = (error as { code?: string })?.code;
            if (!res.headersSent)
                json(res, code === 'GLOBAL_PROVIDER_CONFLICT' ? 409 : 400, {
                    message:
                        error instanceof GlobalProviderInputError
                            ? error.message
                            : code === 'OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED'
                              ? 'Сохранение доступно для обычного OpenCode1.14.48. Неизвестная или другая версия оставлена без изменений; чтение доступно.'
                              : code === 'GLOBAL_PROVIDER_UNKNOWN'
                                ? 'Сохранение выполнено частично. Перечитайте состояние и завершите сохранённое изменение.'
                                : code === 'GLOBAL_PROVIDER_CONFLICT'
                                  ? 'Файлы изменились. Перечитайте состояние; исходные данные сохранены.'
                                  : 'Действие недоступно. Проверьте локальные файлы, права и срок сессии. Черновик остаётся в форме.',
                });
            else res.end();
        });
        pending.add(task);
        void task.then(
            () => pending.delete(task),
            () => pending.delete(task),
        );
    });
    server.requestTimeout = options.limits.httpRequestMs;
    server.headersTimeout = Math.min(options.limits.httpHeadersMs, options.limits.httpRequestMs);
    server.maxHeadersCount = options.limits.httpHeadersCount;
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    // Closing the socket alone does not drain an already admitted filesystem publication.
    let closing: Promise<void> | undefined;
    const close = () =>
        (closing ??= (async () => {
            closed = true;
            session.abort();
            clearTimeout(timer);
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await Promise.allSettled([...pending]);
            active.delete(options.id);
        })());
    const timer = setTimeout(() => void close(), Math.max(1, deadline - Date.now()));
    timer.unref();
    server.unref();
    active.set(options.id, close);
    try {
        await admit();
        const address = server.address();
        if (
            !address ||
            typeof address === 'string' ||
            !(await options.open('http://127.0.0.1:' + address.port + '/#' + token))
        )
            throw Error();
    } catch {
        await close();
        throw Error('Локальное окно не открыто.');
    }
    return { close };
}
export async function closeGlobalProvidersSessions() {
    await Promise.all([...active.values()].map((close) => close()));
}
export async function closeGlobalProvidersSession(id: string) {
    await active.get(id)?.();
}
