import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {aliceSoundPrincipal, bobSoundPrincipal, notificationSoundFixture} from './notification-sound-fixtures';
import {readSoundPreference, soundPrincipal} from '../src/features/NotificationSounds/preferences';

let f: ReturnType<typeof notificationSoundFixture>;
beforeEach(() => {vi.useFakeTimers(); f = notificationSoundFixture();});
afterEach(() => {f.engine.silence(); vi.useRealTimers();});
describe('Personal browser sound preferences', () => {
    it('starts automatic sound OFF at fifty percent without writing a preference', () => {
        expect(f.engine.snapshot()).toMatchObject({enabled: false, volume: 50}); expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled();
    });
    it('Test is an immediate local gesture at the chosen volume and never enables automatic sound', async () => {
        f.engine.change(f.owner.scope, aliceSoundPrincipal, {volume: 25}); f.test(); await vi.advanceTimersByTimeAsync(0);
        expect(f.audio.play).toHaveBeenCalledExactlyOnceWith(0.25); expect(f.engine.snapshot().enabled).toBe(false);
        const reopened = notificationSoundFixture(f.saved); expect(reopened.engine.snapshot()).toMatchObject({enabled: false, volume: 25}); reopened.engine.silence();
    });
    it('the same account retains its setting across roles, projects and a fresh browser runtime', () => {
        f.engine.change(f.owner.scope, aliceSoundPrincipal, {enabled: true, volume: 70});
        f.configure('alice:observer:another-project'); expect(f.engine.snapshot()).toMatchObject({enabled: true, volume: 70});
        const reopened = notificationSoundFixture(f.saved); expect(reopened.engine.snapshot()).toMatchObject({enabled: true, volume: 70}); reopened.engine.silence();
        expect(soundPrincipal({id: 'alice-id', principalName: 'alice'})).toBe(aliceSoundPrincipal);
    });
    it('another account starts quietly and cannot alter the previous account through stale controls', () => {
        f.enable(); f.engine.change(f.owner.scope, aliceSoundPrincipal, {volume: 80});
        f.configure('bob:observer', bobSoundPrincipal); expect(f.engine.snapshot()).toMatchObject({enabled: false, volume: 50});
        f.engine.change('alice:admin', aliceSoundPrincipal, {volume: 1}); f.engine.test('alice:admin', aliceSoundPrincipal);
        expect(f.engine.snapshot()).toMatchObject({enabled: false, volume: 50}); expect(f.factory).not.toHaveBeenCalled();
        f.configure('alice:developer', aliceSoundPrincipal); expect(f.engine.snapshot()).toMatchObject({enabled: true, volume: 80});
    });
    it('zero volume and a global flag OFF make explicit Test silent without destroying the preference', async () => {
        f.engine.change(f.owner.scope, aliceSoundPrincipal, {volume: 0}); f.test(); await vi.advanceTimersByTimeAsync(0); expect(f.factory).not.toHaveBeenCalled();
        f.engine.change(f.owner.scope, aliceSoundPrincipal, {enabled: true, volume: 60}); f.configure(f.owner.scope, aliceSoundPrincipal, false); f.test();
        await vi.advanceTimersByTimeAsync(0); expect(f.factory).not.toHaveBeenCalled(); expect(f.engine.snapshot()).toMatchObject({enabled: true, volume: 60});
        f.engine.change(f.owner.scope, aliceSoundPrincipal, {enabled: false}); expect(f.engine.snapshot().enabled).toBe(false);
    });
    it('unavailable or invalid storage does not overwrite saved data or break session controls', () => {
        const getItem = vi.fn(() => '{invalid'), setItem = vi.fn(); expect(readSoundPreference({getItem, setItem}, aliceSoundPrincipal)).toEqual({enabled: false, volume: 50}); expect(setItem).not.toHaveBeenCalled();
        f.storage.setItem.mockImplementation(() => {throw Error('storage blocked');}); f.engine.change(f.owner.scope, aliceSoundPrincipal, {enabled: true, volume: 35});
        f.configure('alice:observer'); expect(f.engine.snapshot()).toMatchObject({enabled: true, volume: 35, persisted: false});
    });
});
