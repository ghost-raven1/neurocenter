import type { IJobInput } from '../devices/device-job.model';

export interface IAutoUpdateTarget {
    deviceId: string;
    projectId: string;
    bindingId: string;
    assetId: string;
}

export interface IAutoUpdateMutation extends IAutoUpdateTarget {
    enabled: boolean;
    expectedRevision: number;
    requestKey: string;
}

export type TAutoUpdateStatus = 'disabled' | 'waiting' | 'up-to-date' | 'queued' | 'succeeded' | 'attention';

export interface IAutoUpdateRow {
    id: string;
    owner_email: string;
    actor_role: string;
    device_id: string;
    project_id: string;
    binding_id: string;
    asset_id: string;
    enabled: boolean;
    revision: number;
    status: TAutoUpdateStatus;
    message: string;
    next_check_at: string | Date | null;
    checked_at: string | Date | null;
    mutation_key: string;
    mutation_hash: string;
    pending_input: IJobInput | null;
    pending_role: string | null;
    job_id: string | null;
    lease_token: string | null;
    lease_until: string | Date | null;
    job_state?: string | null;
    job_message?: string | null;
}

export interface IAutoUpdateView {
    id: string;
    enabled: boolean;
    revision: number;
    status: TAutoUpdateStatus;
    message: string;
    checkedAt: string | null;
    nextCheckAt: string | null;
    job?: { id: string; state: string; message: string };
}
