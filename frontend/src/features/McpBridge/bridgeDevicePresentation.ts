import type { IBridgeDevice } from './api';

/** Непроверенный снимок не выдаёт прежний online за текущее соединение. */
export function bridgeDeviceStatus(device: IBridgeDevice, verified: boolean): string {
    if (!verified) { return 'статус не проверен'; }
    if (device.requiresReconnect) { return 'подключение истекло'; }
    return device.online ? 'мост на связи' : 'мост не в сети';
}

export function bridgeLastSeen(value: string | null): Date | undefined {
    if (!value) { return undefined; }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
}
