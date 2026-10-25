// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createTabNotificationTracker} from '../src/features/TabNotifications/tracker';
import {mountTabBadge} from '../src/features/TabNotifications/tabBadge';
import {tabDeferred, tabModel, tabRoom, tabService, tabRow, tabSnapshot} from './tab-notification-fixtures';
import {controlledChime, notificationSoundFixture} from './notification-sound-fixtures';

let f: ReturnType<typeof notificationSoundFixture>, tracker: ReturnType<typeof createTabNotificationTracker>, release: () => void;
const advance = async (ms = 250) => {await vi.advanceTimersByTimeAsync(ms);};
const result = (id = 'one') => {tracker.expect(f.owner.scope, tabModel, [id]); tracker.accept(f.owner.scope, tabSnapshot(tabModel, [tabRow(id, 'terminal')], 2));};
beforeEach(() => {
    vi.useFakeTimers(); f = notificationSoundFixture(); f.enable(); tracker = createTabNotificationTracker();
    release = tracker.configure(f.owner.scope, 'alice@example.test', true); tracker.setHidden(true); tracker.subscribeCompletion(f.engine.notify);
});
afterEach(() => {f.engine.silence(); release(); vi.useRealTimers();});

describe('Confirmed tab results produce optional bounded sound', () => {
    it('baseline history, repeated snapshots and status deferrals stay quiet', async () => {
        const baseline = tabSnapshot(tabRoom, [tabRow('old', 'terminal', '1')]);
        tracker.accept(f.owner.scope, baseline); tracker.accept(f.owner.scope, baseline); tracker.defer(f.owner.scope, tabRoom, true);
        await advance(30000); expect(f.audio.play).not.toHaveBeenCalled(); expect(tracker.count()).toBe(0);
    });
    it('an explicit pending receipt can finish on the first read and sounds exactly once', async () => {
        result(); await advance(); expect(f.audio.play).toHaveBeenCalledExactlyOnceWith(0.5);
        tracker.accept(f.owner.scope, tabSnapshot(tabModel, [tabRow('one', 'terminal')], 2)); await advance(10000);
        expect(f.audio.play).toHaveBeenCalledTimes(1); expect(tracker.count()).toBe(1);
    });
    it('a second new completion in an already marked dialogue still gets a new cue', async () => {
        result('one'); await advance(2000); expect(tracker.count()).toBe(1);
        result('two'); await advance(); expect(tracker.count()).toBe(1); expect(f.audio.play).toHaveBeenCalledTimes(2);
    });
    it('a completed review sounds once; a rejected unchanged apply stays quiet until a real later completion', async () => {
        const request = 'service-request', row = (state: 'pending' | 'attention' | 'terminal', version: number) => ({...tabRow(request, state), version});
        tracker.expect(f.owner.scope, tabService, [request]); tracker.accept(f.owner.scope, tabSnapshot(tabService, [row('attention', 3)], 3)); await advance(2000);
        expect(f.audio.play).toHaveBeenCalledTimes(1);
        tracker.expect(f.owner.scope, tabService, [request])(); tracker.accept(f.owner.scope, tabSnapshot(tabService, [row('attention', 3)], 3)); await advance(2000);
        expect(f.audio.play).toHaveBeenCalledTimes(1);
        tracker.expect(f.owner.scope, tabService, [request]); tracker.accept(f.owner.scope, tabSnapshot(tabService, [row('pending', 4)], 4));
        tracker.accept(f.owner.scope, tabSnapshot(tabService, [row('terminal', 5)], 5)); await advance(); expect(f.audio.play).toHaveBeenCalledTimes(2);
    });
    it('visible open results and the users own messages do not sound', async () => {
        tracker.setHidden(false); const close = tracker.view(f.owner.scope, [tabModel]); result(); close();
        tracker.accept(f.owner.scope, tabSnapshot(tabRoom, [tabRow('old', 'terminal', '1')]));
        tracker.accept(f.owner.scope, tabSnapshot(tabRoom, [{...tabRow('own', 'terminal', '2'), actor: 'alice@example.test'}], 2));
        await advance(); expect(f.audio.play).not.toHaveBeenCalled();
    });
    it('opening or revoking the source before the delayed cue cancels that cue', async () => {
        result(); tracker.setHidden(false); const close = tracker.view(f.owner.scope, [tabModel]); await advance(); close();
        result('two'); tracker.forget(f.owner.scope, tabModel); await advance(2000);
        expect(f.audio.play).not.toHaveBeenCalled(); expect(tracker.count()).toBe(0);
    });
    it('keeps an unseen completion when the last source in a burst is opened before the cue', async () => {
        result('first');
        tracker.expect(f.owner.scope, tabService, ['second']);
        tracker.accept(f.owner.scope, tabSnapshot(tabService, [tabRow('second', 'terminal')], 2));
        tracker.setHidden(false); const close = tracker.view(f.owner.scope, [tabService]);
        try {
            await advance(); expect(tracker.count()).toBe(1); expect(f.audio.play).toHaveBeenCalledTimes(1);
        } finally {close();}
    });
    it('a burst coalesces without overlapping sound or a delayed backlog', async () => {
        for (let i = 0; i < 30; i++) result('burst-' + i);
        await advance(); expect(f.audio.play).toHaveBeenCalledTimes(1);
        result('during-sound'); await advance(300); result('during-cooldown'); await advance(10000);
        expect(f.audio.play).toHaveBeenCalledTimes(1); expect(f.audio.stop).toHaveBeenCalledOnce();
    });
    it.each(['mute', 'zero', 'flag'] as const)('%s stops pending and active audio while retaining the badge', async action => {
        const stop = () => action === 'flag' ? f.configure(f.owner.scope, f.engine.snapshot().principal, false)
            : f.engine.change(f.owner.scope, f.engine.snapshot().principal, action === 'mute' ? {enabled: false} : {volume: 0});
        result(); stop(); await advance(1000); expect(f.audio.play).not.toHaveBeenCalled();
        f.configure(); f.enable(); f.engine.change(f.owner.scope, f.engine.snapshot().principal, {volume: 50});
        result('next'); await advance(); expect(f.audio.play).toHaveBeenCalledOnce(); stop();
        expect(f.audio.stop).toHaveBeenCalledOnce(); expect(f.audio.close).toHaveBeenCalled(); expect(tracker.count()).toBe(1);
    });
    it.each(['role', 'logout'] as const)('a late resume after %s cannot play for the stale owner', async action => {
        const pending = tabDeferred<void>(); f.audio.setState('suspended'); f.audio.resume.mockReturnValueOnce(pending.promise);
        result(); await advance(); expect(f.audio.resume).toHaveBeenCalledOnce();
        if (action === 'role') f.configure('alice:observer'); else {f.owner.scope = ''; f.engine.silence();}
        f.audio.setState('running'); pending.resolve(); await advance(2000); expect(f.audio.play).not.toHaveBeenCalled();
    });
    it.each(['unsupported', 'rejected'] as const)('%s audio leaves the real tab badge working', async failure => {
        const head = document.head.innerHTML; document.head.innerHTML = '<title>Нейроцентр</title><link rel="icon" href="/brand.svg">';
        const badge = mountTabBadge(document), unsubscribe = tracker.subscribe(() => badge.update(tracker.count()));
        try {
            if (failure === 'unsupported') f.factory.mockReturnValueOnce(undefined);
            else {f.audio.setState('suspended'); f.audio.resume.mockRejectedValueOnce(Error('autoplay blocked'));}
            result(); await advance(); expect(document.title).toBe('(1) Нейроцентр'); expect(f.audio.play).not.toHaveBeenCalled();
            expect(f.engine.snapshot().status).toBe(failure === 'unsupported' ? 'unsupported' : 'blocked');
            result('next'); await advance(10000); expect(f.factory).toHaveBeenCalledTimes(1);
        } finally {unsubscribe(); badge.dispose(); document.head.innerHTML = head;}
    });
    it('a browser resume that never settles times out; a later explicit Test may recover without replay', async () => {
        const pending = tabDeferred<void>(); f.audio.setState('suspended'); f.audio.resume.mockReturnValueOnce(pending.promise);
        result(); await advance(1500); expect(f.engine.snapshot()).toMatchObject({status: 'blocked', busy: false});
        f.audio.setState('running'); pending.resolve(); await advance(); expect(f.audio.play).not.toHaveBeenCalled();
        const recovered = controlledChime(); f.factory.mockReturnValueOnce(recovered.port); f.test(); await advance(0);
        expect(recovered.play).toHaveBeenCalledOnce(); expect(f.engine.snapshot().enabled).toBe(true);
    });
    it('a failed optional completion listener cannot interrupt notification state', async () => {
        tracker.subscribeCompletion(() => {throw Error('optional cue failed');});
        expect(() => result()).not.toThrow(); await advance(); expect(tracker.count()).toBe(1); expect(f.audio.play).toHaveBeenCalledOnce();
    });
});
