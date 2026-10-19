import { isAxiosError } from 'axios';

/** Сетевой сбой допускает старую сводку; отказ доступа требует удалить её. */
export function maintenanceAccessDenied(failure: unknown): boolean {
    return isAxiosError(failure) && [401, 403].includes(failure.response?.status ?? 0);
}

export interface IMaintenanceReadFailure {
    message: string;
    accessDenied: boolean;
}
