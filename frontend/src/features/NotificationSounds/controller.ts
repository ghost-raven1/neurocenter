import {tabSourceKey, type TabCompletion} from '../TabNotifications/types';
import {readSoundPreference, writeSoundPreference} from './preferences';
import {defaultSoundPreference, type ChimeAudio, type SoundPreference, type SoundState, type SoundStorage} from './types';

interface Ports {audio: () => ChimeAudio | undefined; storage: SoundStorage; now: () => number;
    schedule: (run: () => void, delay: number) => ReturnType<typeof setTimeout>; cancel: (timer: ReturnType<typeof setTimeout>) => void;}

/** One Core-owned sound lifetime coalesces bursts and discards stale asynchronous resumes. */
export function createNotificationSounds(ports: Ports) {
    let state: SoundState = {principal: '', ...defaultSoundPreference(), status: 'ready', busy: false, persisted: true};
    let scope = '', enabled = false, owns = () => false, session = 0, generation = 0, lastPlayed = -Infinity;
    let audio: ChimeAudio | undefined, stopPlaying: (() => void) | undefined;
    const queued = new Map<string, () => boolean>();
    let timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    const listeners = new Set<() => void>();
    const publish = (patch: Partial<SoundState>): void => {state = {...state, ...patch}; listeners.forEach(listener => listener());};
    const allowed = (): boolean => !!scope && !!state.principal && enabled && owns();
    const silence = (): void => {
        generation++; queued.clear();
        if (timer !== undefined) ports.cancel(timer); if (deadline !== undefined) ports.cancel(deadline); timer = undefined; deadline = undefined;
        try {stopPlaying?.();} catch {/* Audio teardown cannot affect notifications. */} stopPlaying = undefined;
        try {audio?.close();} catch {/* Unsupported or already closed contexts are harmless. */} audio = undefined;
        publish({busy: false});
    };
    const start = (preview: boolean, current: () => boolean = () => true): void => {
        if (!allowed() || !current() || !state.volume || state.busy || !preview && (!state.enabled || state.status !== 'ready' || ports.now() - lastPlayed < 1500)) return;
        const token = generation, valid = (): boolean => token === generation && allowed() && current() && (preview || state.enabled);
        const blocked = (): void => {if (token === generation) {silence(); publish({status: 'blocked'});}};
        try {
            audio ??= ports.audio();
            if (!audio) {publish({status: 'unsupported'}); return;}
            publish({busy: true});
            deadline = ports.schedule(blocked, 1200);
            // resume is invoked synchronously from the Test gesture, before awaiting its promise.
            const resumed = audio.state() === 'running' ? Promise.resolve() : audio.resume();
            void resumed.then(() => {
                if (!valid()) {if (token === generation) silence(); return;}
                if (audio?.state() !== 'running') {blocked(); return;}
                if (deadline !== undefined) ports.cancel(deadline); deadline = undefined;
                try {
                    stopPlaying = audio.play(state.volume / 100); lastPlayed = ports.now(); publish({status: 'ready'});
                    timer = ports.schedule(() => {timer = undefined; try {stopPlaying?.();} catch {/* Natural completion may have stopped it. */} stopPlaying = undefined; publish({busy: false});}, 300);
                } catch {blocked();}
            }, blocked);
        } catch {blocked();}
    };
    return {
        snapshot: (): SoundState => state,
        subscribe: (listener: () => void): (() => void) => {listeners.add(listener); return () => {listeners.delete(listener);};},
        configure(nextScope: string, principal: string, on: boolean, currentOwner: () => boolean): () => void {
            const token = ++session; silence(); scope = nextScope; enabled = on; owns = currentOwner; lastPlayed = -Infinity;
            const same = principal === state.principal, preference = same ? {enabled: state.enabled, volume: state.volume} : principal ? readSoundPreference(ports.storage, principal) : defaultSoundPreference();
            publish({principal, ...preference, status: 'ready', persisted: same ? state.persisted : true});
            return () => {if (session === token) {silence(); scope = ''; enabled = false; owns = () => false;}};
        },
        change(currentScope: string, principal: string, patch: Partial<SoundPreference>): void {
            if (!scope || scope !== currentScope || !owns() || principal !== state.principal) return;
            const preference = {enabled: patch.enabled ?? state.enabled, volume: patch.volume === undefined ? state.volume : Math.min(100, Math.max(0, Math.round(patch.volume)))};
            if (!Number.isFinite(preference.volume)) return;
            silence(); publish({...preference, persisted: writeSoundPreference(ports.storage, principal, preference)});
        },
        notify(event: TabCompletion): void {
            if (event.scope !== scope || !allowed() || !state.enabled || !state.volume || state.status !== 'ready' || state.busy || !event.isCurrent()) return;
            queued.set(tabSourceKey(event.source), event.isCurrent);
            if (timer !== undefined) return;
            timer = ports.schedule(() => {timer = undefined; const current = [...queued.values()]; queued.clear(); start(false, () => current.some(owns => owns()));}, 250);
        },
        test(currentScope: string, principal: string): void {
            if (currentScope !== scope || principal !== state.principal || state.busy) return;
            if (timer !== undefined) ports.cancel(timer); timer = undefined; queued.clear(); start(true);
        },
        silence,
    };
}
