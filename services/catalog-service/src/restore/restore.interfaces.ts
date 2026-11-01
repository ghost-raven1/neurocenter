import type {
    IRestorePreviewInput,
    IRestoreInput,
    IRestorePreview,
    IRestoreReceipt,
    IRestoreRunnerReport,
} from '../../../shared/web-restore.cjs';

export type {
    IRestorePreviewInput as RestorePreviewInput,
    IRestoreInput as RestoreInput,
    IRestorePreview as RestorePreview,
    IRestoreReceipt as RestoreReceipt,
    IRestoreRunnerReport as RestoreRunnerReport,
};

export type TRestoreState = 'queued' | 'running' | 'ready' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';

export interface IRestoreJob {
    id: string;
    actor: string;
    request_key: string;
    kind: 'preview' | 'restore';
    input: IRestorePreviewInput | IRestoreInput;
    input_hash: string;
    state: TRestoreState;
    preview: IRestorePreview | null;
    receipt: IRestoreReceipt | null;
    error_code: string | null;
    message: string;
    runner_id: string | null;
    lease_id: string | null;
    lease_until: Date | null;
    created_at: Date;
    updated_at: Date;
}

export interface IRestoreRunner {
    runner_id: string;
    config_digest: string;
    target_prefix: string;
    checkpoints: IRestoreRunnerReport['checkpoints'];
    seen_at: Date;
}
