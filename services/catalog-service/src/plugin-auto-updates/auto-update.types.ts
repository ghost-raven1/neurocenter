import type { JobInput } from '../devices/device-job.model';
export interface AutoUpdateTarget {
    deviceId: string;
    projectId: string;
    bindingId: string;
    assetId: string;
}
export interface AutoUpdateMutation extends AutoUpdateTarget {
    enabled: boolean;
    expectedRevision: number;
    requestKey: string;
}
export type AutoUpdateStatus = 'disabled' | 'waiting' | 'up-to-date' | 'queued' | 'succeeded' | 'attention';
export interface AutoUpdateRow {
    id: string;
    owner_email: string;
    actor_role: string;
    device_id: string;
    project_id: string;
    binding_id: string;
    asset_id: string;
    enabled: boolean;
    revision: number;
    status: AutoUpdateStatus;
    message: string;
    next_check_at: string | Date | null;
    checked_at: string | Date | null;
    mutation_key: string;
    mutation_hash: string;
    pending_input: JobInput | null;
    pending_role: string | null;
    job_id: string | null;
    lease_token: string | null;
    lease_until: string | Date | null;
    job_state?: string | null;
    job_message?: string | null;
}
export interface AutoUpdateView {
    id: string;
    enabled: boolean;
    revision: number;
    status: AutoUpdateStatus;
    message: string;
    checkedAt: string | null;
    nextCheckAt: string | null;
    job?: { id: string; state: string; message: string };
}
export function autoUpdateView(row: AutoUpdateRow): AutoUpdateView {
    const iso = (value: string | Date | null) => (value === null ? null : new Date(value).toISOString());
    return {
        id: row.id,
        enabled: row.enabled,
        revision: Number(row.revision),
        status: row.status,
        message: row.message,
        checkedAt: iso(row.checked_at),
        nextCheckAt: iso(row.next_check_at),
        ...(row.job_id
            ? {
                  job: {
                      id: row.job_id,
                      state: row.job_state ?? 'unknown',
                      message: (row.job_message ?? '').slice(0, 1000),
                  },
              }
            : {}),
    };
}
