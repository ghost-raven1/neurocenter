export interface IMaintenanceWindow {
    days: number[];
    start: string;
    end: string;
}

export interface IMaintenancePolicy {
    enabled: boolean;
    timeZone: string;
    schedule: { days: number[]; time: string };
    windows: IMaintenanceWindow[];
    maxPauseMinutes: number;
    localCopies: number;
    externalRetentionDays: number;
    rpoMinutes: number;
    rtoMinutes: number;
}

export interface IMaintenanceRun {
    id: string;
    slot: string;
    state: 'running' | 'failed' | 'succeeded';
    errorCode: string | null;
    startedAt: string;
    finishedAt: string | null;
}

export interface IMaintenanceStatus {
    revision: number;
    policy: IMaintenancePolicy;
    updatedAt: string;
    nextRunAt: string | null;
    externalAgeSeconds: number | null;
    rpoExceeded: boolean;
    external: {
        verifiedAt: string;
        createdAt: string;
        backupId: string;
        storageId: string;
    } | null;
    runs: IMaintenanceRun[];
}

export interface IMaintenancePolicyResult {
    revision: number;
    policy: IMaintenancePolicy;
}

const failureDescriptions: Record<string, string> = {
    BACKUP_FAILED: 'Полный комплект не создан. Проверьте приватный журнал runner.',
    EXTERNAL_FAILED: 'Передача или чтение внешней копии не подтверждены. Локальный комплект сохранён для повтора.',
    PAUSE_EXCEEDED: 'Истёк предел паузы. Проверьте возврат сервисов в работу.',
    CONFIG_CHANGED: 'Настройки изменились до запуска. Следующий проход прочитает новую ревизию.',
    RUNNING: 'Предыдущий запуск ещё не завершён. Оператору нужно проверить его состояние.',
    RETENTION_FAILED: 'Копия подтверждена, но очистка локальных комплектов не завершена.',
};

export function maintenanceFailure(code: string | null): string {
    return failureDescriptions[code || ''] || code || 'Причина не записана';
}

/** Черновик формы не должен менять сохранённые значения по ссылке. */
export function copyMaintenancePolicy(policy: IMaintenancePolicy): IMaintenancePolicy {
    return {
        ...policy,
        schedule: { ...policy.schedule, days: [...policy.schedule.days] },
        windows: policy.windows.map(window => ({ ...window, days: [...window.days] })),
    };
}

/** Возраст относится к точке данных копии, а не к моменту последней передачи. */
export function formatBackupAge(seconds: number | null): string {
    if (seconds === null) { return 'Нет проверенной внешней копии'; }
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

/** Время расписания показывается в выбранном поясе, независимо от браузера. */
export function formatScheduledBackup(value: string, timeZone: string): string {
    return new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone });
}
