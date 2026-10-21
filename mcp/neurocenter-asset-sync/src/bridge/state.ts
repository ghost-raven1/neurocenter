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
export async function api<T>(route: string, input?: unknown, tokenOverride?: string): Promise<T> {
    const credentials = await readState<Credentials>('credentials');
    const response = await fetch(apiHub() + '/api/device-channel/' + route, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(tokenOverride || credentials
                ? { authorization: `Bearer ${tokenOverride || credentials!.token}` }
                : {}),
        },
        body: JSON.stringify(input ?? {}),
        signal: AbortSignal.timeout(20000),
    });
    const data = (await response.json()) as { message?: unknown };
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
