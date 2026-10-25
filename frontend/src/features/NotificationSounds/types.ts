export interface SoundPreference {enabled: boolean; volume: number;}
export interface SoundState extends SoundPreference {principal: string; status: 'ready' | 'blocked' | 'unsupported'; busy: boolean; persisted: boolean;}
/** Browser audio stays behind a controllable local port; it never requests notification permission. */
export interface ChimeAudio {state: () => string; resume: () => Promise<void>; play: (volume: number) => () => void; close: () => void;}
export interface SoundStorage {getItem: (key: string) => string | null; setItem: (key: string, value: string) => void;}
export const defaultSoundPreference = (): SoundPreference => ({enabled: false, volume: 50});
