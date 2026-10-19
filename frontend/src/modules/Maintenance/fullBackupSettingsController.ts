import { errorMessage } from '../../common/utils/errorMessage';

import { copyMaintenancePolicy } from './maintenancePolicy';
import type { IMaintenancePolicy, IMaintenancePolicyResult, IMaintenanceStatus } from './maintenancePolicy';
import { createMaintenanceRequestScope } from './maintenanceRequestScope';
import { maintenanceAccessDenied } from './maintenanceReadFailure';

export interface IFullBackupSettingsState {
    status: IMaintenanceStatus | null;
    revision: number | null;
    loading: boolean;
    saving: boolean;
    loadError: string | null;
    saveError: string | null;
}

interface IControllerOptions {
    read: () => Promise<IMaintenanceStatus>;
    write: (revision: number, policy: IMaintenancePolicy) => Promise<IMaintenancePolicyResult>;
    onChange: (state: IFullBackupSettingsState) => void;
    onPolicy: (policy: IMaintenancePolicy) => void;
    onSaved: () => void;
    onAccessDenied?: () => void;
}

export function initialFullBackupSettingsState(): IFullBackupSettingsState {
    return { status: null, revision: null, loading: false, saving: false, loadError: null, saveError: null };
}

/** Чтение обновляет статус; черновик и ошибка сохранения имеют отдельный жизненный цикл. */
export function createFullBackupSettingsController(options: IControllerOptions) {
    const scope = createMaintenanceRequestScope();
    let state = initialFullBackupSettingsState();

    const update = (changes: Partial<IFullBackupSettingsState>): void => {
        state = { ...state, ...changes };
        options.onChange(state);
    };
    const denyAccess = (message: string): void => {
        options.onAccessDenied?.();
        update({ status: null, revision: null, loadError: message, saveError: null });
    };

    const readStatus = async (): Promise<void> => {
        const isCurrent = scope.next();
        update({ loading: true });
        try {
            const status = await options.read();
            if (!isCurrent()) { return; }
            if (state.revision === null) {
                options.onPolicy(copyMaintenancePolicy(status.policy));
                update({ revision: status.revision });
            }
            update({ status, loadError: null });
        } catch (failure) {
            if (isCurrent()) {
                const message = errorMessage(failure, 'Не удалось загрузить настройки обслуживания');
                if (maintenanceAccessDenied(failure)) { denyAccess(message); }
                else { update({ loadError: message }); }
            }
        } finally {
            if (isCurrent()) { update({ loading: false }); }
        }
    };

    return {
        activate(): void {
            scope.activate();
            state = initialFullBackupSettingsState();
            options.onChange(state);
        },
        dispose(): void {
            scope.dispose();
        },
        async refresh(): Promise<void> {
            if (!scope.isActive() || state.saving) { return; }
            await readStatus();
        },
        async save(policy: IMaintenancePolicy): Promise<void> {
            const isOwnerCurrent = scope.captureOwner();
            if (!isOwnerCurrent() || state.saving || state.revision === null) { return; }

            // PATCH отменяет влияние предыдущих GET, а poll ждёт завершения сохранения.
            const isCurrent = scope.next();
            const revision = state.revision;
            update({ saving: true, loading: false, saveError: null });
            try {
                const saved = await options.write(revision, copyMaintenancePolicy(policy));
                if (!isCurrent()) { return; }
                options.onPolicy(copyMaintenancePolicy(saved.policy));
                update({
                    revision: saved.revision,
                    status: state.status ? { ...state.status, ...saved } : null,
                });
                options.onSaved();
                await readStatus();
            } catch (failure) {
                if (isCurrent()) {
                    const message = errorMessage(failure, 'Не удалось сохранить настройки. Введённые значения остались в форме.');
                    if (maintenanceAccessDenied(failure)) { denyAccess(message); }
                    else { update({ saveError: message }); }
                }
            } finally {
                if (isOwnerCurrent()) { update({ saving: false }); }
            }
        },
        useSavedPolicy(): void {
            if (!scope.isActive() || state.saving || !state.status) { return; }
            options.onPolicy(copyMaintenancePolicy(state.status.policy));
            update({ revision: state.status.revision, saveError: null });
        },
    };
}
