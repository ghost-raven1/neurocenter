import type { IUserInfo } from '../../core/interfaces';
import { defaultSoundPreference } from './utils';
import { type ISoundPreference, type ISoundStorage } from './interfaces';

/** Preferences follow a stable account, never its active role or selected project. */
export function soundPrincipal(user: Pick<IUserInfo, 'id' | 'principalName'> | null | undefined): string {
    return user?.id && user.principalName ? JSON.stringify([user.id, user.principalName]) : '';
}
const storageKey = (principal: string): string => 'neurocenter.notification-sounds.v1.' + encodeURIComponent(principal);
/** Invalid or inaccessible browser storage starts quietly and does not alter saved bytes. */
export function readSoundPreference(storage: ISoundStorage, principal: string): ISoundPreference {
    try {
        const value: unknown = JSON.parse(storage.getItem(storageKey(principal)) ?? 'null');
        if (value && typeof value === 'object') {
            const row = value as Record<string, unknown>;
            if (
                row.version === 1 &&
                typeof row.enabled === 'boolean' &&
                Number.isInteger(row.volume) &&
                Number(row.volume) >= 0 &&
                Number(row.volume) <= 100
            )
                return { enabled: row.enabled, volume: Number(row.volume) };
        }
    } catch {
        /* Private browsing and invalid data must not block notifications. */
    }
    return defaultSoundPreference();
}
/** A storage failure keeps the current session usable without claiming persistence. */
export function writeSoundPreference(storage: ISoundStorage, principal: string, preference: ISoundPreference): boolean {
    try {
        storage.setItem(storageKey(principal), JSON.stringify({ version: 1, ...preference }));
        return true;
    } catch {
        return false;
    }
}
