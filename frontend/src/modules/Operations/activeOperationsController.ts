import type { IOperationPage } from '../../core/api/interfaces';
import { operationReadStatus } from './operationReadFailure';

export interface IActiveOperations {
    count: number;
    percent: number | null;
    running: number | null;
    queued: number | null;
    updatedAt: string | null;
    stale: boolean;
    accessDenied: boolean;
}

export function initialActiveOperations(): IActiveOperations {
    return { count: 0, percent: null, running: null, queued: null, updatedAt: null, stale: false, accessDenied: false };
}

/** Среднее приходит по всей активной очереди, а не по первой странице истории. */
export function activeOperationsFromPage(page: IOperationPage): IActiveOperations {
    const count = Math.max(0, page.activeCount);
    const progress = page.activeProgress;
    const known = progress && Number.isFinite(progress.percent)
        && Number.isFinite(progress.running) && Number.isFinite(progress.queued);
    return {
        count,
        percent: count > 0 && known ? Math.round(Math.min(100, Math.max(0, progress.percent))) : null,
        running: known ? progress.running : null,
        queued: known ? progress.queued : null,
        updatedAt: new Date().toISOString(),
        stale: false,
        accessDenied: false,
    };
}

/** Смена владельца и новый запрос отсекают прежние ответы, включая ошибку старого запроса. */
export function createActiveOperationsController(
    read: () => Promise<IOperationPage>,
    onChange: (value: IActiveOperations) => void,
) {
    let active = false;
    let generation = 0;
    let value = initialActiveOperations();

    return {
        activate(): void {
            active = true;
            generation++;
            value = initialActiveOperations();
            onChange(value);
        },
        dispose(): void {
            active = false;
            generation++;
        },
        async refresh(): Promise<void> {
            if (!active) { return; }
            const request = ++generation;
            try {
                const page = await read();
                if (!active || request !== generation) { return; }
                value = activeOperationsFromPage(page);
                onChange(value);
            } catch (failure) {
                if (!active || request !== generation) { return; }
                const status = operationReadStatus(failure);
                value = status === 401 || status === 403
                    ? { ...initialActiveOperations(), stale: true, accessDenied: true }
                    : { ...value, stale: true };
                onChange(value);
            }
        },
    };
}
