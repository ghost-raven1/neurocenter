import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { atomicText } from './atomic-file.js';
import { readBoundedUtf8 } from './read-bounded.js';
export const jobContext = new AsyncLocalStorage<{
    id: string;
    lease: string;
    deviceId?: string;
}>();

export const hash = (text: string | Buffer): string =>
    createHash('sha256').update(text).digest('hex');
export const hub = (): string =>
    new URL(process.env.NEUROCENTER_URL || 'http://localhost:5173').origin;
/** API transport can change without replacing the existing site identity and its private state namespace. */
export const apiHub = (): string => {
    const value = process.env.NEUROCENTER_API_URL;
    if (!value) return hub();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error('Адрес API Gateway должен быть HTTP(S) origin без ключей и параметров.');
    return url.origin;
};
export const stateDir = (): string =>
    path.join(
        process.env.NEUROCENTER_BRIDGE_HOME ||
            path.join(os.homedir(), '.config', 'neurocenter', 'bridge'),
        hash(hub()).slice(0, 20),
    );
export interface Credentials {
    token: string;
    deviceId: string;
    email: string;
}
export interface Workspace {
    root?: string;
    bindings: Record<string, string>;
}

/** Секрет устройства отделён от OpenCode-конфига и доступен только локальному пользователю. */
export async function readState<T>(name: string): Promise<T | undefined> {
    try {
        return JSON.parse(
            await readBoundedUtf8(path.join(stateDir(), name + '.json'), 1048576),
        ) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw new Error('Повреждена локальная настройка MCP: ' + name);
    }
}
export async function writeState(name: string, value: unknown): Promise<void> {
    await fs.mkdir(stateDir(), { recursive: true, mode: 0o700 });
    const target = path.join(stateDir(), name + '.json');
    await atomicText(target, JSON.stringify(value, null, 2), 0o600);
}
const transportCodes = new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET',
    'DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','ERR_TLS_CERT_ALTNAME_INVALID']);
/** Only the API origin and known transport codes enter CLI output; the original error remains private. */
function apiTransportError(origin: string, cause: unknown): Error {
    const error = cause as {name?: unknown;code?: unknown;cause?: {code?: unknown}} | null;
    const code = error?.name === 'TimeoutError' ? 'TIMEOUT'
        : [error?.code,error?.cause?.code].find(value => typeof value === 'string' && transportCodes.has(value));
    return new Error(`Не удалось связаться с API ${origin}${code ? ' (' + code + ')' : ''}. Проверьте доступность сервера и настройки сети.`, {cause});
}
/** Caller cancellation supplements the existing transport deadline without changing other requests. */
export async function api<T>(route: string, input?: unknown, tokenOverride?: string, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const credentials = await readState<Credentials>('credentials');
    signal?.throwIfAborted();
    const origin = apiHub();
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    const cancelled = (cause: unknown) => signal?.aborted && (cause === signal.reason
        || (cause as {name?: unknown} | null)?.name === 'AbortError' && requestSignal.reason === signal.reason);
    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(tokenOverride || credentials
                ? { authorization: `Bearer ${tokenOverride || credentials!.token}` }
                : {}),
        },
        body: JSON.stringify(input ?? {}),
        signal: requestSignal,
    };
    let response: Response;
    try { response = await fetch(origin + '/api/device-channel/' + route, options); }
    catch (cause) { if (cancelled(cause)) { throw signal!.reason; } throw apiTransportError(origin, cause); }
    let data: { message?: unknown };
    try { data = (await response.json()) as { message?: unknown }; }
    catch (cause) { if (cancelled(cause)) { throw signal!.reason; } throw cause; }
    if (!response.ok) {
        throw Object.assign(new Error(
            typeof data.message === 'string'
                ? data.message
                : `Сервер MCP: HTTP ${response.status}`,
        ), { status: response.status });
    }
    return data as T;
}

/** Старые MCP-инструменты используют ту же отзываемую личную привязку через gateway. */
export async function authorizedFetch(
    route: string,
    options: RequestInit = {},
): Promise<Response> {
    const credentials = await readState<Credentials>('credentials');
    if (!credentials) {
        throw new Error(
            'Сначала выполните connect_neurocenter и подтвердите подключение на сайте.',
        );
    }
    const job = jobContext.getStore();
    return fetch(apiHub() + route, {
        ...options,
        headers: {
            ...options.headers,
            authorization: `Bearer ${credentials.token}`,
            ...(job
                ? {
                      'x-neurocenter-job-id': job.id,
                      'x-neurocenter-job-lease': job.lease,
                  }
                : {}),
        },
        signal: options.signal || AbortSignal.timeout(30000),
    });
}
