import type { ISoundPreference } from './interfaces';

export const defaultSoundPreference = (): ISoundPreference => ({ enabled: false, volume: 50 });
