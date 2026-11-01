export interface IRestoreCheckpoint {
    id: string;
    label: string;
    sha256: string;
    createdAt: string;
}

export interface IRestorePreviewInput {
    requestKey: string;
    checkpointId: string;
    checkpointSha256: string;
    targetProject: string;
}

export interface IRestoreInput {
    requestKey: string;
    previewId: string;
    digest: string;
    confirmation: string;
}

export interface IRestorePreview {
    checkpointId: string;
    checkpointSha256: string;
    targetProject: string;
    configDigest: string;
    checkedAt: string;
    expiresAt: string;
    digest: string;
    impact: {
        databases: string[];
        volumes: string[];
        files: number;
        bytes: number;
        applicationsStarted: false;
        currentStackChanged: false;
    };
}

export interface IRestoreReceipt {
    ok: true;
    projectName: string;
    sha256: string;
    restoredAt: string;
    databases: number;
    durationMs: number;
    applicationsStarted: false;
}

export type TRestoreState = 'queued' | 'running' | 'ready' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';

export interface IRestoreJob {
    id: string;
    requestKey: string;
    kind: 'preview' | 'restore';
    state: TRestoreState;
    input: IRestorePreviewInput | IRestoreInput;
    preview: IRestorePreview | null;
    receipt: IRestoreReceipt | null;
    errorCode: string | null;
    message: string;
    createdAt: string;
    updatedAt: string;
}

export interface IRestoreStatus {
    runner: { available: boolean; targetPrefix?: string; lastSeenAt?: string };
    checkpoints: IRestoreCheckpoint[];
    jobs: IRestoreJob[];
}

export type TRestoreIntent =
    { kind: 'preview'; input: IRestorePreviewInput } | { kind: 'restore'; input: IRestoreInput };
