import {describe, expect, it} from 'vitest';
import {createTabNotificationTracker} from '../src/features/TabNotifications/tracker';
import {tabModel, tabRoom, tabService, tabRow, tabSnapshot} from './tab-notification-fixtures';

function setup() {
    let time = 0;
    const tracker = createTabNotificationTracker(() => time); tracker.configure('alice', 'alice@example.test', true); tracker.setHidden(true);
    return {tracker, advance: (ms: number) => {time += ms;}};
}
describe('Known background work and visited rooms', () => {
    it('uses old history as a baseline and detects a confirmed completion after closing its view', () => {
        const {tracker, advance} = setup(); const close = tracker.view('alice', [tabModel]);
        tracker.accept('alice', tabSnapshot(tabModel, [tabRow('old', 'terminal'), tabRow('waiting')]));
        expect(tracker.count()).toBe(0); close(); advance(4000); expect(tracker.next('alice')).toEqual(tabModel);
        tracker.accept('alice', tabSnapshot(tabModel, [tabRow('old', 'terminal'), tabRow('waiting', 'terminal')], 2));
        expect(tracker.count()).toBe(1); expect(tracker.next('alice')).toBeUndefined();
        tracker.accept('alice', tabSnapshot(tabModel, [tabRow('waiting', 'terminal')], 2)); expect(tracker.count()).toBe(1);
    });
    it('does not lose a fast first terminal GET for an explicit pending receipt or notify older unrelated history', () => {
        const {tracker} = setup(); tracker.expect('alice', tabModel, ['exact-request']);
        tracker.accept('alice', tabSnapshot(tabModel, [tabRow('older', 'terminal', '2026-10-24T00:00:00Z'), tabRow('exact-request', 'terminal')]));
        expect(tracker.count()).toBe(1);
        const close = tracker.view('alice', [tabModel]); tracker.setHidden(false); expect(tracker.count()).toBe(0); close();
        tracker.expect('alice', tabModel, ['next']); tracker.setHidden(true);
        tracker.accept('alice', tabSnapshot(tabModel, [tabRow('older', 'terminal')], 2)); expect(tracker.count()).toBe(0);
    });
    it('marks awaiting review as attention, then can follow an explicit apply without another inference', () => {
        const {tracker} = setup(); tracker.expect('alice', tabService, ['request']);
        tracker.accept('alice', tabSnapshot(tabService, [{...tabRow('request', 'attention'), version: 3}])); expect(tracker.count()).toBe(1);
        const close = tracker.view('alice', [tabService]); tracker.setHidden(false); close(); expect(tracker.count()).toBe(0);
        tracker.expect('alice', tabService, ['request']); tracker.setHidden(true);
        tracker.accept('alice', tabSnapshot(tabService, [{...tabRow('request', 'terminal'), version: 5}], 2)); expect(tracker.count()).toBe(1);
    });
    it('does not invent a completion from a missing pending row or a network failure', () => {
        const {tracker, advance} = setup(); tracker.accept('alice', tabSnapshot(tabModel, [tabRow('pending')])); advance(4000);
        tracker.defer('alice', tabModel, true); tracker.accept('alice', tabSnapshot(tabModel, [], 2));
        expect(tracker.count()).toBe(0); expect(tracker.pendingIds('alice', tabModel)).toEqual(['pending']);
        expect(tracker.next('alice')).toBeUndefined(); advance(15000); expect(tracker.next('alice')).toEqual(tabModel);
    });
    it('keeps another source available while one subsystem waits for retry', () => {
        const {tracker, advance} = setup(); tracker.expect('alice', tabModel, ['model-request']); tracker.expect('alice', tabService, ['role-request']); advance(4000);
        tracker.defer('alice', tabModel, true); expect(tracker.next('alice')).toEqual(tabService); expect(tracker.count()).toBe(0);
    });
    it('prioritizes pending work without starving visited rooms or letting many passive rooms stall a job', () => {
        const {tracker, advance} = setup(); tracker.expect('alice', tabModel, ['request']);
        for (const id of ['room-one', 'room-two', 'room-three']) tracker.accept('alice', tabSnapshot({...tabRoom, id}, []));
        advance(4000); expect(tracker.next('alice')).toEqual(tabModel); tracker.defer('alice', tabModel);
        advance(12000); const passive = tracker.next('alice')!; expect(passive.kind).toBe('project'); tracker.defer('alice', passive);
        advance(4000); expect(tracker.next('alice')).toEqual(tabModel);
    });
    it('deduplicates TEAM messages at bigint positions and ignores own posts and older loaded history', () => {
        const {tracker} = setup(); tracker.accept('alice', tabSnapshot(tabRoom, [tabRow('initial', 'terminal', '9007199254740992')]));
        tracker.accept('alice', tabSnapshot(tabRoom, [{...tabRow('mine', 'terminal', '9007199254740993'), actor: 'alice@example.test'}], 2)); expect(tracker.count()).toBe(0);
        const incoming = {...tabRow('other', 'terminal', '9007199254740994'), actor: 'bob@example.test'};
        tracker.accept('alice', tabSnapshot(tabRoom, [incoming], 3)); tracker.accept('alice', tabSnapshot(tabRoom, [incoming], 3)); expect(tracker.count()).toBe(1);
        const close = tracker.view('alice', [tabRoom]); tracker.setHidden(false); close();
        tracker.accept('alice', tabSnapshot(tabRoom, [tabRow('old-history', 'terminal', '1'), incoming], 3)); expect(tracker.count()).toBe(0);
    });
    it('retains pending TEAM slots outside the current page and rotates the existing 50-ID GET window', () => {
        const {tracker} = setup(); const ids = Array.from({length: 60}, (_, index) => `slot-${index}`);
        tracker.accept('alice', tabSnapshot(tabRoom, ids.map((id, index) => tabRow(id, 'pending', String(index + 1)))));
        tracker.accept('alice', tabSnapshot(tabRoom, [], 2));
        const first = tracker.pendingIds('alice', tabRoom), second = tracker.pendingIds('alice', tabRoom);
        expect(first).toHaveLength(50); expect(second).toHaveLength(50); expect(new Set([...first, ...second]).size).toBe(60); expect(tracker.count()).toBe(0);
    });
    it('does not let an older snapshot revive settled work', () => {
        const {tracker} = setup(); tracker.accept('alice', tabSnapshot(tabModel, [tabRow('turn')], 3));
        tracker.accept('alice', tabSnapshot(tabModel, [tabRow('turn', 'terminal')], 5));
        tracker.accept('alice', tabSnapshot(tabModel, [tabRow('turn')], 4));
        expect(tracker.pendingIds('alice', tabModel)).toEqual([]); expect(tracker.count()).toBe(1);
    });
});
describe('Authorization, visibility and flag lifecycle', () => {
    it('removing access invalidates the corresponding in-flight read and badge', () => {
        const {tracker} = setup(); tracker.expect('alice', tabModel, ['request']); const current = tracker.captureRead('alice', tabModel);
        tracker.accept('alice', tabSnapshot(tabModel, [tabRow('request', 'terminal')])); expect(tracker.count()).toBe(1);
        tracker.forget('alice', tabModel); expect(current()).toBe(false); expect(tracker.count()).toBe(0); expect(tracker.next('alice')).toBeUndefined();
        tracker.accept('alice', tabSnapshot(tabModel, [tabRow('request')], 1)); tracker.accept('alice', tabSnapshot(tabModel, [tabRow('request', 'terminal')], 2));
        expect(tracker.count()).toBe(0); expect(tracker.next('alice')).toBeUndefined();
    });
    it('another account or role cannot inherit watches or apply a late authorized snapshot', () => {
        const {tracker} = setup(); tracker.expect('alice', tabModel, ['request']); const current = tracker.captureRead('alice', tabModel);
        tracker.configure('alice:new-role', 'alice@example.test', true); tracker.accept('alice', tabSnapshot(tabModel, [tabRow('request', 'terminal')]));
        expect(current()).toBe(false); expect(tracker.count()).toBe(0); expect(tracker.next('alice:new-role')).toBeUndefined();
    });
    it('foregrounding the site acknowledges only an open source, without clearing another closed dialogue', () => {
        const {tracker} = setup(); tracker.expect('alice', tabModel, ['model']); tracker.expect('alice', tabService, ['service']);
        tracker.accept('alice', tabSnapshot(tabModel, [tabRow('model', 'terminal')])); tracker.accept('alice', tabSnapshot(tabService, [tabRow('service', 'terminal')]));
        const close = tracker.view('alice', [tabModel]); expect(tracker.count()).toBe(2); tracker.setHidden(false); expect(tracker.count()).toBe(1); close();
    });
    it('OFF and monitor disposal drop observation only; subsequent registration cannot start another read', () => {
        const {tracker, advance} = setup(); tracker.expect('alice', tabModel, ['request']); const release = tracker.configure('alice', 'alice@example.test', false);
        tracker.expect('alice', tabModel, ['request']); advance(10000); expect(tracker.next('alice')).toBeUndefined(); expect(tracker.count()).toBe(0); release();
    });
});
