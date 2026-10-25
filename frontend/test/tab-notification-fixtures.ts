import type {TabRow, TabSnapshot, TabSource} from '../src/features/TabNotifications/types';

export const tabModel: TabSource = {kind: 'model', id: 'chat-one', projectId: 'prj-one'};
export const tabRoom: TabSource = {kind: 'project', id: 'room-one', projectId: 'prj-one'};
export const tabService: TabSource = {kind: 'service', id: 'service-one', projectId: 'prj-one'};
export const tabRow = (id: string, state: TabRow['state'] = 'pending', order = '2026-10-25T00:00:01Z'): TabRow => ({id, state, order});
export const tabSnapshot = (source: TabSource, rows: TabRow[], revision = 1): TabSnapshot => ({source, rows, revision});
export function tabDeferred<T>() {
    let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
    const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;});
    return {promise, resolve, reject};
}
