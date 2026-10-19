import { isAxiosError } from 'axios';

import { errorMessage } from '../../common/utils/errorMessage';
import type { IPage, IProjectListParams, IProjectSummary } from '../../core/api/interfaces';

interface IAvailableProjectsOptions {
    getScope: () => string;
    readPage: (params: IProjectListParams) => Promise<IPage<IProjectSummary>>;
    onChange: (state: IAvailableProjectsState) => void;
}

export interface IAvailableProjectsState {
    projects: IProjectSummary[];
    loading: boolean;
    ready: boolean;
    error: string;
}

export function initialAvailableProjectsState(): IAvailableProjectsState {
    return { projects: [], loading: true, ready: false, error: '' };
}

/** Временная ошибка сохраняет известные проекты, а отказ доступа и смена прав скрывают прежние сведения. */
export function createAvailableProjectsController(options: IAvailableProjectsOptions) {
    const scope = options.getScope();
    let active = false;
    let owner = 0;
    let sequence = 0;
    let state = initialAvailableProjectsState();
    const update = (changes: Partial<IAvailableProjectsState>): void => {
        state = { ...state, ...changes };
        options.onChange(state);
    };

    return {
        activate(): void {
            active = true;
            owner++;
            state = initialAvailableProjectsState();
            options.onChange(state);
        },
        dispose(): void {
            active = false;
            owner++;
        },
        async refresh(): Promise<void> {
            if (!active || !scope || scope !== options.getScope()) { return; }
            const currentOwner = owner;
            const request = ++sequence;
            const isCurrent = (): boolean => active && owner === currentOwner
                && request === sequence && scope === options.getScope();
            update({ loading: true, error: '' });
            try {
                const projects: IProjectSummary[] = [];
                for (let page = 1; ; page++) {
                    const result = await options.readPage({ page, size: 100 });
                    if (!isCurrent()) { return; }
                    projects.push(...result.items);
                    if (result.page * result.size >= result.total || !result.items.length) { break; }
                }
                update({ projects, ready: true });
            } catch (failure) {
                if (isCurrent()) {
                    const denied = isAxiosError(failure) && [401, 403, 404].includes(failure.response?.status ?? 0);
                    update({ ...(denied ? { projects: [], ready: false } : {}), error: errorMessage(failure, 'Не удалось загрузить проекты.') });
                }
            } finally {
                if (isCurrent()) { update({ loading: false }); }
            }
        },
    };
}
