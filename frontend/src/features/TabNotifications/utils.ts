import type { TTabSource } from './interfaces';

export const tabSourceKey = (source: TTabSource): string => JSON.stringify([source.kind, source.projectId, source.id]);

/** Project positions are bigint strings; dialogue dates are canonical sortable timestamps. */
export function compareTabOrder(source: TTabSource, left: string, right: string): number {
    if (source.kind !== 'project') return left.localeCompare(right);
    if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return 0;
    const a = BigInt(left),
        b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
}
