import type { IAutoUpdateRow, IAutoUpdateView } from './auto-update.interfaces';

export function autoUpdateView(row: IAutoUpdateRow): IAutoUpdateView {
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
