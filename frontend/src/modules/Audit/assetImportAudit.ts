import type {IAuditEvent} from '../../core/api/interfaces';

export interface IAuditImportItem {assetId: string; name: string; kind: string; version: string}
interface IAuditImport {ids: string[]; items: IAuditImportItem[]; repository?: string; commit?: string}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Names describe the pinned import request, including after a catalogue card is renamed or removed. */
export function auditImportSnapshot(event: IAuditEvent): IAuditImport | undefined {
    if (event.action !== 'asset.import.request') return;
    const input = record(event.details?.after), ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === 'string') : [];
    const items = (Array.isArray(input.items) ? input.items : []).flatMap(value => {
        const item = record(value);
        return typeof item.assetId === 'string' && ids.includes(item.assetId) && typeof item.name === 'string' && item.name.trim() && typeof item.kind === 'string' && typeof item.version === 'string'
            ? [{assetId: item.assetId, name: item.name, kind: item.kind, version: item.version}] : [];
    });
    return {ids, items, ...(typeof input.repository === 'string' ? {repository: input.repository} : {}), ...(typeof input.commit === 'string' ? {commit: input.commit} : {})};
}

export function auditImportTitle(event: IAuditEvent): string | undefined {
    const snapshot = auditImportSnapshot(event); if (!snapshot) return;
    if (!snapshot.items.length) return snapshot.ids.length ? `Импорт ассетов · позиций: ${snapshot.ids.length}` : 'Запрос импорта ассетов';
    const names = snapshot.items.slice(0, 2).map(item => item.name), rest = snapshot.ids.length - names.length;
    return names.join(', ') + (rest > 0 ? ` и ещё ${rest}` : '');
}
