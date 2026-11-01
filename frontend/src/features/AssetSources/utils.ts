import type { IImportIntent } from './interfaces';
import { ASSET_IMPORT_MAX_ITEMS } from './constants';

export const activeImport = (state: string): boolean => ['QUEUED', 'RUNNING'].includes(state);

export function readImportIntent(value: string | null): IImportIntent | undefined {
    try {
        const parsed = JSON.parse(value ?? 'null') as IImportIntent;
        if (
            parsed &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(parsed.requestKey) &&
            /^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/.test(parsed.commit) &&
            Array.isArray(parsed.ids) &&
            parsed.ids.length > 0 &&
            parsed.ids.length <= ASSET_IMPORT_MAX_ITEMS &&
            parsed.ids.every((id) => typeof id === 'string') &&
            new Set(parsed.ids).size === parsed.ids.length &&
            (parsed.jobId === undefined || /^[a-f0-9-]{36}$/.test(parsed.jobId))
        ) {
            return { ...parsed, rejected: parsed.rejected === true && !parsed.jobId ? true : undefined };
        }
    } catch {
        /* Неполный локальный черновик не становится запросом сервера. */
    }
    return undefined;
}
