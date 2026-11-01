import { isAxiosError } from 'axios';
import { errorMessage } from '../../common/utils/errorMessage';
import type { IStoreApp } from '../../features/Catalog/interfaces';

export type TToolCatalogSource = 'plugins' | 'skills';
export interface IToolCatalogSourceState {
    apps: IStoreApp[];
    ready: boolean;
    loading: boolean;
    error: string;
}
export type TToolCatalogState = Record<TToolCatalogSource, IToolCatalogSourceState>;
export const toolCatalogSources: TToolCatalogSource[] = ['plugins', 'skills'];
export const toolCatalogSource = (kind: IStoreApp['kind']): TToolCatalogSource =>
    kind === 'skill' ? 'skills' : 'plugins';
export const initialToolCatalogState = (): TToolCatalogState => ({
    plugins: { apps: [], ready: false, loading: true, error: '' },
    skills: { apps: [], ready: false, loading: true, error: '' },
});

/** Каждый источник публикуется отдельно; старый ответ не меняет новый запрос или владельца. */
export function createToolCatalogController(options: {
    captureOwner: () => () => boolean;
    read: (source: TToolCatalogSource, isCurrent: () => boolean) => Promise<IStoreApp[] | null>;
    onChange: (state: TToolCatalogState) => void;
}) {
    let active = false,
        state = initialToolCatalogState();
    const requests: Record<TToolCatalogSource, number> = { plugins: 0, skills: 0 };
    const update = (source: TToolCatalogSource, change: Partial<IToolCatalogSourceState>): void => {
        state = { ...state, [source]: { ...state[source], ...change } };
        options.onChange(state);
    };
    const read = async (source: TToolCatalogSource): Promise<void> => {
        const owns = options.captureOwner();
        if (!active || !owns()) return;
        const request = ++requests[source];
        const current = (): boolean => active && request === requests[source] && owns();
        update(source, { loading: true, error: '' });
        try {
            const apps = await options.read(source, current);
            if (current() && apps !== null) update(source, { apps, ready: true });
        } catch (error) {
            if (!current()) return;
            const denied = isAxiosError(error) && [401, 403, 404].includes(error.response?.status ?? 0);
            update(source, {
                error: errorMessage(error, 'Повторите загрузку источника.'),
                ...(denied ? { apps: [], ready: false } : {}),
            });
        } finally {
            if (current()) update(source, { loading: false });
        }
    };
    return {
        activate(): void {
            active = true;
            requests.plugins++;
            requests.skills++;
            state = initialToolCatalogState();
            options.onChange(state);
        },
        dispose(): void {
            active = false;
            requests.plugins++;
            requests.skills++;
        },
        async refresh(source?: TToolCatalogSource): Promise<void> {
            if (source) await read(source);
            else await Promise.all(toolCatalogSources.map(read));
        },
    };
}
