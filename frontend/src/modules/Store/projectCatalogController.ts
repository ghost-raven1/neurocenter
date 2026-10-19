import { isAxiosError } from 'axios';

import { errorMessage } from '../../common/utils/errorMessage';
import type { IProjectAsset } from '../../core/api/interfaces';

export interface IProjectCatalogState {
    assets: IProjectAsset[];
    ready: boolean;
    loading: boolean;
    error: string;
}

export const initialProjectCatalogState = (): IProjectCatalogState => ({ assets: [], ready: false, loading: true, error: '' });

/** Ответ и повтор принадлежат тому проекту и набору прав, в котором началось чтение. */
export function createProjectCatalogController(options: {
    getScope: () => string;
    read: () => Promise<IProjectAsset[]>;
    onChange: (state: IProjectCatalogState) => void;
}) {
    const scope = options.getScope();
    let active = false;
    let sequence = 0;
    let state = initialProjectCatalogState();
    const update = (changes: Partial<IProjectCatalogState>): void => {
        state = { ...state, ...changes };
        options.onChange(state);
    };
    return {
        activate(): void { active = true; sequence++; state = initialProjectCatalogState(); options.onChange(state); },
        dispose(): void { active = false; sequence++; },
        async refresh(): Promise<void> {
            if (!active || options.getScope() !== scope) { return; }
            const request = ++sequence;
            const current = (): boolean => active && request === sequence && options.getScope() === scope;
            update({ loading: true, error: '' });
            try {
                const assets = await options.read();
                if (current()) { update({ assets, ready: true }); }
            } catch (failure) {
                if (!current()) { return; }
                const status = isAxiosError(failure) ? failure.response?.status : undefined;
                const denied = status === 401 || status === 403 || status === 404;
                update({ error: errorMessage(failure, 'Не удалось прочитать каталог проекта. Повторите загрузку.'),
                    ...(denied ? { assets: [], ready: false } : {}) });
            } finally { if (current()) { update({ loading: false }); } }
        },
    };
}
