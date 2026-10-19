import { errorMessage } from '../../common/utils/errorMessage';

import { createMaintenanceRequestScope } from './maintenanceRequestScope';
import { maintenanceAccessDenied } from './maintenanceReadFailure';

export interface ICapacityResource {
    freeBytes: number;
    totalBytes: number;
    walBytes?: number;
}

export interface ICapacityStatus {
    available: boolean;
    reason?: string;
    observedAt?: string;
    reserveBytes?: number;
    resources?: Record<string, ICapacityResource>;
}

export interface ICapacityStatusState {
    data: ICapacityStatus | null;
    loading: boolean;
    error: string | null;
}

export const capacityResourceLabels: Record<string, string> = {
    postgres: 'PostgreSQL',
    wal: 'Журнал PostgreSQL (WAL)',
    skills: 'Файлы скиллов',
    projects: 'Серверные проекты',
    backups: 'Копии и их временные файлы',
    'runtime-artifacts': 'Готовые комплекты и staging',
};

export function initialCapacityStatusState(): ICapacityStatusState {
    return { data: null, loading: false, error: null };
}

/** Поздний poll не заменяет результат ручного обновления или данные нового аккаунта. */
export function createCapacityStatusController(
    read: () => Promise<ICapacityStatus>,
    onChange: (state: ICapacityStatusState) => void,
) {
    const scope = createMaintenanceRequestScope();
    let state = initialCapacityStatusState();
    const update = (changes: Partial<ICapacityStatusState>): void => {
        state = { ...state, ...changes };
        onChange(state);
    };

    return {
        activate(): void {
            scope.activate();
            state = initialCapacityStatusState();
            onChange(state);
        },
        dispose(): void {
            scope.dispose();
        },
        async refresh(): Promise<void> {
            if (!scope.isActive()) { return; }
            const isCurrent = scope.next();
            update({ loading: true });
            try {
                const data = await read();
                if (isCurrent()) { update({ data, error: null }); }
            } catch (failure) {
                if (isCurrent()) {
                    update({
                        error: errorMessage(failure, 'Не удалось обновить физическое место'),
                        ...(maintenanceAccessDenied(failure) ? { data: null } : {}),
                    });
                }
            } finally {
                if (isCurrent()) { update({ loading: false }); }
            }
        },
    };
}
