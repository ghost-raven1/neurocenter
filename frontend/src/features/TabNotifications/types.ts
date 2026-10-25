export type TabSource =
    | {kind: 'model' | 'service' | 'operation'; id: string; projectId: string | null}
    | {kind: 'project'; id: string; projectId: string};
export interface TabRow {id: string; order: string; state: 'pending' | 'attention' | 'terminal'; version?: number; stamp?: string; actor?: string;}
export interface TabSnapshot {source: TabSource; rows: TabRow[]; revision?: number;}
/** A confirmed new result, still owned and unseen when a delayed optional cue runs. */
export interface TabCompletion {scope: string; source: TabSource; isCurrent: () => boolean;}
export const tabSourceKey = (source: TabSource): string => JSON.stringify([source.kind, source.projectId, source.id]);
export const TAB_PENDING_POLL_MS = 4000;
export const TAB_ROOM_POLL_MS = 15000;

/** Project positions are bigint strings; dialogue dates are canonical sortable timestamps. */
export function compareTabOrder(source: TabSource, left: string, right: string): number {
    if (source.kind !== 'project') return left.localeCompare(right);
    if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return 0;
    const a = BigInt(left), b = BigInt(right); return a < b ? -1 : a > b ? 1 : 0;
}
