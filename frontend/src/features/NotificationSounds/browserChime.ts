import type {ChimeAudio} from './types';

/** A short, soft synthesized chime uses no downloaded assets or external requests. */
export function createBrowserChime(): ChimeAudio | undefined {
    const Audio = globalThis.AudioContext ?? (globalThis as typeof globalThis & {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
    if (!Audio) return;
    const context = new Audio();
    return {
        state: () => context.state,
        resume: () => context.resume(),
        play: volume => {
            const oscillator = context.createOscillator(), gain = context.createGain(), start = context.currentTime;
            oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(660, start); oscillator.frequency.linearRampToValueAtTime(880, start + 0.12);
            gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(volume * 0.12, start + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
            oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start); oscillator.stop(start + 0.25);
            return () => {try {oscillator.stop();} catch {/* The scheduled chime may already have ended. */} oscillator.disconnect(); gain.disconnect();};
        },
        close: () => {void context.close().catch(() => undefined);},
    };
}
