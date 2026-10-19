import { isAxiosError } from 'axios';
import type { IBridgeDevice, IBridgeInstallation, IBridgeJob } from './api';

export type TBridgeResource = 'devices' | 'jobs' | 'installations';
export type TBridgeReadResult<T> = { ok: true; data: T[] } | { ok: false; error: string; accessDenied?: true };
export type TBridgeErrors = Record<TBridgeResource, string>;

interface IBridgeReader {
    devices: () => Promise<IBridgeDevice[]>;
    jobs: () => Promise<IBridgeJob[]>;
    installations: () => Promise<IBridgeInstallation[]>;
}
interface IBridgeReadCallbacks {
    devices: (result: TBridgeReadResult<IBridgeDevice>) => void;
    jobs: (result: TBridgeReadResult<IBridgeJob>) => void;
    installations: (result: TBridgeReadResult<IBridgeInstallation>) => void;
}

/** Ошибка личного списка не подменяется сообщением о правах на выбранный проект. */
export function bridgeReadError(resource: TBridgeResource, cause: unknown): string {
    const label = { devices: 'список компьютеров', jobs: 'статусы установок', installations: 'список установленных инструментов' }[resource];
    return isAxiosError(cause) && cause.response?.status === 401
        ? `Войдите в профиль снова, чтобы увидеть ${label}.`
        : `Не удалось загрузить ${label}. Попробуйте обновить данные.`;
}

async function read<T>(resource: TBridgeResource, request: () => Promise<T[]>, receive: (result: TBridgeReadResult<T>) => void): Promise<void> {
    try {
        const data = await request();
        if (!Array.isArray(data)) { throw new Error('Неполный ответ сервера'); }
        receive({ ok: true, data });
    } catch (cause) {
        const accessDenied = isAxiosError(cause) && [401, 403, 404].includes(cause.response?.status || 0);
        receive({ ok: false, error: bridgeReadError(resource, cause), ...(accessDenied ? { accessDenied: true as const } : {}) });
    }
}

/** Каждый список отображается сразу после своего ответа, независимо от остальных. */
export async function readBridgeResources(api: IBridgeReader, receive: IBridgeReadCallbacks): Promise<void> {
    await Promise.allSettled([
        read('devices', () => api.devices(), receive.devices),
        read('jobs', () => api.jobs(), receive.jobs),
        read('installations', () => api.installations(), receive.installations),
    ]);
}

/** Отсутствие устройств подтверждается только успешным чтением их списка. */
export function bridgeConnectionState(devicesCount: number, devicesReady: boolean, devicesError: string): 'connected' | 'empty' | 'loading' | 'error' {
    if (devicesCount > 0) { return 'connected'; }
    if (devicesError) { return 'error'; }
    return devicesReady ? 'empty' : 'loading';
}
