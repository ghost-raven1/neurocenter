import {compareTabOrder, TAB_PENDING_POLL_MS, TAB_ROOM_POLL_MS, tabSourceKey, type TabCompletion, type TabRow, type TabSnapshot, type TabSource} from './types';

interface Expected {before?: TabRow; rejected: boolean;}
interface Watch {source: TabSource; rows: Map<string, TabRow>; expected: Map<string, Expected>; revision?: number; watermark: string; attention: boolean; nextRead: number; offset: number; baselined: boolean;}

/** Only registered, authorized sources are retained. Counts describe changed sources, never a global unread total. */
export function createTabNotificationTracker(now: () => number = () => Date.now()) {
    let owner = '', actor = '', enabled = false, hidden = false, generation = 0, lastPassiveRead = 0;
    const watches = new Map<string, Watch>(), open = new Map<string, number>(), listeners = new Set<() => void>();
    const denied = new Set<string>();
    const configurationListeners = new Set<() => void>();
    const completionListeners = new Set<(event: TabCompletion) => void>();
    const emit = (): void => {listeners.forEach(listener => listener());};
    const allowed = (scope: string): boolean => enabled && !!owner && owner === scope;
    const pending = (watch: Watch): boolean => !!watch.expected.size || [...watch.rows.values()].some(row => row.state === 'pending');
    const clearVisible = (): void => {if (!hidden) watches.forEach((watch, key) => {if (open.has(key)) watch.attention = false;});};
    const removeUnused = (): void => {watches.forEach((watch, key) => {
        if (watch.source.kind !== 'project' && !open.has(key) && !watch.attention && !pending(watch)) watches.delete(key);
    });};
    const configure = (scope: string, email: string, on: boolean): (() => void) => {
        const token = ++generation; owner = scope; actor = email; enabled = !!scope && on; lastPassiveRead = now();
        watches.clear(); open.clear(); denied.clear(); configurationListeners.forEach(listener => listener()); emit();
        return () => {if (generation === token) {generation++; enabled = false; owner = ''; actor = ''; watches.clear(); open.clear(); denied.clear(); emit();}};
    };
    const accept = (scope: string, value: TabSnapshot): void => {
        if (!allowed(scope)) return;
        const key = tabSourceKey(value.source), previous = watches.get(key);
        if (denied.has(key)) return;
        if (previous?.revision !== undefined && value.revision !== undefined && value.revision < previous.revision) return;
        const watch: Watch = previous ?? {source: value.source, rows: new Map(), expected: new Map(), watermark: '', attention: false, nextRead: now(), offset: 0, baselined: false};
        const rows = new Map<string, TabRow>(); let completed = false;
        for (const row of value.rows) {
            const old = watch.rows.get(row.id), expected = watch.expected.get(row.id), before = expected?.before;
            if (old && ((old.version ?? 0) > (row.version ?? 0)
                || old.state !== 'pending' && row.state === 'pending' && (old.version ?? 0) >= (row.version ?? 0)
                && (value.revision ?? 0) <= (watch.revision ?? 0))) {rows.set(old.id, old); continue;}
            const settled = old?.state === 'pending' && row.state !== 'pending';
            // An attempted POST is not a state change. Unknown ACKs retain the last confirmed baseline.
            const changed = !!expected && (!before || (before.version !== undefined ? (row.version ?? 0) > before.version
                : row.state !== before.state || !!row.stamp && !!before.stamp && row.stamp !== before.stamp));
            const expectedResult = changed && row.state !== 'pending';
            const arrived = watch.baselined && !old && row.state !== 'pending' && compareTabOrder(value.source, row.order, watch.watermark) > 0;
            if (previous && (settled || arrived || expectedResult) && row.actor !== actor && (hidden || !open.has(key))) {watch.attention = true; completed = true;}
            if (settled || expectedResult || expected?.rejected && !changed) watch.expected.delete(row.id);
            rows.set(row.id, row);
        }
        // A pending row can fall outside the latest server page; absence never proves completion.
        watch.rows.forEach(row => {if (row.state === 'pending' && !rows.has(row.id)) rows.set(row.id, row);});
        for (const row of value.rows) if (!watch.watermark || compareTabOrder(value.source, row.order, watch.watermark) > 0) watch.watermark = row.order;
        watch.rows = rows; watch.revision = value.revision ?? watch.revision; watch.baselined = true;
        if (!previous) watch.nextRead = now() + (pending(watch) ? TAB_PENDING_POLL_MS : TAB_ROOM_POLL_MS);
        watches.set(key, watch); clearVisible(); removeUnused(); emit();
        if (completed) {
            const token = generation, isCurrent = (): boolean => allowed(scope) && generation === token && watches.get(key) === watch && watch.attention && (hidden || !open.has(key));
            if (isCurrent()) completionListeners.forEach(listener => {try {listener({scope, source: value.source, isCurrent});} catch {/* Optional cues cannot interrupt badge or status delivery. */}});
        }
    };
    const expect = (scope: string, source: TabSource, ids: readonly string[]): (() => void) => {
        if (!allowed(scope) || !ids.length) return () => undefined;
        const token = generation, key = tabSourceKey(source), watch = watches.get(key) ?? {source, rows: new Map(), expected: new Map(), watermark: '', attention: false, nextRead: now(), offset: 0, baselined: false};
        denied.delete(key);
        const attempts = ids.map(id => {const value = {before: watch.expected.get(id)?.before ?? watch.rows.get(id), rejected: false}; watch.expected.set(id, value); return {id, value};});
        watch.nextRead = Math.min(watch.nextRead, now() + TAB_PENDING_POLL_MS); watches.set(key, watch); emit();
        return () => {if (allowed(scope) && token === generation && watches.get(key) === watch) {
            attempts.forEach(({id, value}) => {if (watch.expected.get(id) === value) {
                if (!value.before && !watch.rows.has(id)) watch.expected.delete(id); else value.rejected = true;
            }}); removeUnused(); emit();
        }};
    };
    const view = (scope: string, sources: readonly TabSource[]): (() => void) => {
        if (!allowed(scope)) return () => undefined;
        const token = generation, keys = sources.map(tabSourceKey);
        keys.forEach(key => {if (!open.has(key)) denied.delete(key); open.set(key, (open.get(key) ?? 0) + 1);}); clearVisible(); emit();
        return () => {if (token !== generation) return; keys.forEach(key => {const count = open.get(key) ?? 0; if (count > 1) open.set(key, count - 1); else open.delete(key);}); removeUnused(); emit();};
    };
    const next = (scope: string): TabSource | undefined => {
        if (!allowed(scope)) return;
        const eligible = [...watches.entries()].filter(([key, watch]) => watch.nextRead <= now() && (hidden || !open.has(key))
            && (pending(watch) || watch.source.kind === 'project'))
            .sort(([, a], [, b]) => a.nextRead - b.nextRead).map(([, watch]) => watch);
        const work = eligible.find(pending), room = eligible.find(watch => !pending(watch));
        const selected = work && (!room || now() - lastPassiveRead < TAB_ROOM_POLL_MS) ? work : room ?? work;
        if (selected && !pending(selected)) lastPassiveRead = now();
        return selected?.source;
    };
    const defer = (scope: string, source: TabSource, failed = false): void => {
        const watch = allowed(scope) && watches.get(tabSourceKey(source));
        if (watch) watch.nextRead = now() + (failed ? TAB_ROOM_POLL_MS : pending(watch) ? TAB_PENDING_POLL_MS : TAB_ROOM_POLL_MS);
    };
    const forget = (scope: string, source: TabSource): void => {if (allowed(scope)) {const key = tabSourceKey(source); watches.delete(key); denied.add(key); emit();}};
    const captureRead = (scope: string, source: TabSource): (() => boolean) => {
        const token = generation, key = tabSourceKey(source), watch = watches.get(key);
        return () => allowed(scope) && generation === token && !!watch && watches.get(key) === watch;
    };
    const pendingIds = (scope: string, source: TabSource): string[] => {
        const watch = allowed(scope) && watches.get(tabSourceKey(source)); if (!watch) return [];
        const ids = [...new Set([...watch.rows.values()].filter(row => row.state === 'pending').map(row => row.id).concat([...watch.expected.keys()]))]; if (!ids.length) return [];
        // The existing TEAM GET accepts at most 50 watched IDs; rotate older slots rather than dropping them.
        const size = source.kind === 'project' ? Math.min(50, ids.length) : 1, start = watch.offset % ids.length;
        watch.offset = (start + size) % ids.length;
        return Array.from({length: size}, (_, index) => ids[(start + index) % ids.length]);
    };
    return {configure, accept, expect, view, next, defer, forget, pendingIds, captureRead,
        setHidden: (value: boolean): void => {hidden = value; clearVisible(); removeUnused(); emit();},
        count: (): number => [...watches.values()].filter(watch => watch.attention).length,
        subscribe: (listener: () => void): (() => void) => {listeners.add(listener); return () => {listeners.delete(listener);};},
        subscribeConfiguration: (listener: () => void): (() => void) => {configurationListeners.add(listener); return () => {configurationListeners.delete(listener);};},
        subscribeCompletion: (listener: (event: TabCompletion) => void): (() => void) => {completionListeners.add(listener); return () => {completionListeners.delete(listener);};},
    };
}

export const tabNotifications = createTabNotificationTracker();
