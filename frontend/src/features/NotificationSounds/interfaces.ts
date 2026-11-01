export interface ISoundPreference {
    enabled: boolean;
    volume: number;
}

/** Browser audio stays behind a controllable local port; it never requests notification permission. */
export interface IChimeAudio {
    state: () => string;
    resume: () => Promise<void>;
    play: (volume: number) => () => void;
    close: () => void;
}

export interface ISoundStorage {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
}
