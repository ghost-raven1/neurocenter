export type TTabSource =
    | { kind: 'model' | 'service' | 'operation'; id: string; projectId: string | null }
    | { kind: 'project'; id: string; projectId: string };

export interface ITabRow {
    id: string;
    order: string;
    state: 'pending' | 'attention' | 'terminal';
    version?: number;
    stamp?: string;
    actor?: string;
}

export interface ITabSnapshot {
    source: TTabSource;
    rows: ITabRow[];
    revision?: number;
}

/** A confirmed new result, still owned and unseen when a delayed optional cue runs. */
export interface ITabCompletion {
    scope: string;
    source: TTabSource;
    isCurrent: () => boolean;
}
