import {vi} from 'vitest';
import {createNotificationSounds} from '../src/features/NotificationSounds/controller';
import type {ChimeAudio} from '../src/features/NotificationSounds/types';
import {soundPrincipal} from '../src/features/NotificationSounds/preferences';

export const aliceSoundPrincipal = soundPrincipal({id: 'alice-id', principalName: 'alice'});
export const bobSoundPrincipal = soundPrincipal({id: 'bob-id', principalName: 'bob'});
/** A controlled browser boundary exposes audible starts and teardown, never oscillator implementation. */
export function controlledChime() {
    let state = 'running';
    const stop = vi.fn(), play = vi.fn((_volume: number) => stop), close = vi.fn(() => {state = 'closed';});
    const resume = vi.fn(async () => {state = 'running';});
    const port: ChimeAudio = {state: () => state, resume, play, close};
    return {port, resume, play, close, stop, setState: (next: string): void => {state = next;}};
}
/** Each scenario owns isolated local storage and an explicit auth owner plus controlled timers. */
export function notificationSoundFixture(saved = new Map<string, string>()) {
    const audio = controlledChime(), factory = vi.fn<() => ChimeAudio | undefined>(() => audio.port);
    const storage = {getItem: vi.fn((key: string) => saved.get(key) ?? null), setItem: vi.fn((key: string, value: string) => {saved.set(key, value);})};
    const engine = createNotificationSounds({audio: factory, storage, now: () => Date.now(), schedule: (run, delay) => setTimeout(run, delay), cancel: timer => clearTimeout(timer)});
    const owner = {scope: 'alice:admin'};
    const configure = (scope = owner.scope, principal = aliceSoundPrincipal, enabled = true) => {
        owner.scope = scope; return engine.configure(scope, principal, enabled, () => owner.scope === scope);
    };
    configure();
    return {engine, audio, factory, storage, saved, owner, configure,
        enable: (): void => engine.change(owner.scope, engine.snapshot().principal, {enabled: true}),
        test: (): void => engine.test(owner.scope, engine.snapshot().principal)};
}
