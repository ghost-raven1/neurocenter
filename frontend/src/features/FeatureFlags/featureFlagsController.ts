import { isAxiosError } from 'axios';
import { errorMessage } from '../../common/utils/errorMessage';
import { featureFlagKeys, requireFeatureFlag, requireFeatureFlagList } from './types';
import type { IFeatureFlag, TFeatureFlagKey } from './types';

export interface IFeatureFlagRowState {
    saving: boolean; error: string | null; needsReview: boolean; saved: boolean;
    choice?: { enabled: boolean; reviewedRevision: number | null };
}
export interface IFeatureFlagsState {
    items: IFeatureFlag[] | null;
    loading: boolean;
    readError: string | null;
    rows: Record<TFeatureFlagKey, IFeatureFlagRowState>;
}
interface IOptions {
    read: () => Promise<unknown>;
    write: (key: TFeatureFlagKey, enabled: boolean, expectedRevision: number) => Promise<unknown>;
    captureOwner: () => () => boolean;
    onChange: (state: IFeatureFlagsState) => void;
}
const emptyRow = (): IFeatureFlagRowState => ({ saving: false, error: null, needsReview: false, saved: false });
export function initialFeatureFlagsState(): IFeatureFlagsState {
    return { items: null, loading: false, readError: null,
        rows: Object.fromEntries(featureFlagKeys.map(key => [key, emptyRow()])) as IFeatureFlagsState['rows'] };
}
const status = (failure: unknown): number | undefined => isAxiosError(failure) ? failure.response?.status : undefined;

/** Каждая строка сохраняется отдельно; GET не перезаписывает результат PATCH и прежнего владельца. */
export function createFeatureFlagsController(options: IOptions) {
    let state = initialFeatureFlagsState(), active = false, epoch = 0, readSequence = 0, queuedRead = false;
    const pending = new Map<TFeatureFlagKey, symbol>();
    const update = (changes: Partial<IFeatureFlagsState>): void => { state = { ...state, ...changes }; options.onChange(state); };
    const row = (key: TFeatureFlagKey, changes: Partial<IFeatureFlagRowState>): void =>
        update({ rows: { ...state.rows, [key]: { ...state.rows[key], ...changes } } });
    const owner = (): (() => boolean) => {
        const captured = epoch, owns = options.captureOwner();
        return () => active && captured === epoch && owns();
    };
    const denied = (message: string): void => update({ ...initialFeatureFlagsState(), readError: message });
    const refresh = async (): Promise<void> => {
        const currentOwner = owner();
        if (!currentOwner()) return;
        if (pending.size) { queuedRead = true; return; }
        const request = ++readSequence;
        const current = (): boolean => currentOwner() && request === readSequence;
        update({ loading: true });
        try {
            const items = requireFeatureFlagList(await options.read());
            if (current()) update({ items, readError: null, rows: Object.fromEntries(featureFlagKeys.map(key => {
                const previous = state.rows[key];
                return [key, previous.choice ? { ...previous, error: previous.needsReview ? previous.error : null,
                    choice: { ...previous.choice, reviewedRevision: items.find(flag => flag.key === key)!.revision } }
                    : previous.needsReview ? previous : emptyRow()];
            })) as IFeatureFlagsState['rows'] });
        } catch (failure) {
            if (current()) {
                const message = errorMessage(failure, 'Не удалось загрузить функции платформы. Состояние не подтверждено.');
                if ([401, 403].includes(status(failure) ?? 0)) denied(message);
                else update({ readError: message });
            }
        } finally { if (current()) update({ loading: false }); }
    };
    const save = async (key: TFeatureFlagKey, enabled: boolean, reviewedChoice = false): Promise<void> => {
        const current = owner(), existing = state.items?.find(flag => flag.key === key);
        const previous = state.rows[key];
        if (!current() || !existing || state.loading || state.readError || pending.has(key) || existing.enabled === enabled) return;
        if (reviewedChoice ? previous.choice?.enabled !== enabled || previous.choice.reviewedRevision !== existing.revision
            : previous.needsReview || previous.choice) return;
        const token = Symbol(key); pending.set(key, token); readSequence++;
        row(key, { saving: true, error: null, saved: false, needsReview: false, choice: { enabled, reviewedRevision: null } });
        try {
            const saved = requireFeatureFlag(await options.write(key, enabled, existing.revision));
            if (!current()) return;
            if (saved.key !== key || saved.enabled !== enabled || saved.revision <= existing.revision) {
                throw new Error('Сервер не подтвердил изменение функции. Обновите настройки.');
            }
            update({ items: state.items?.map(flag => flag.key === key ? saved : flag) ?? null });
            row(key, { saved: true, choice: undefined });
        } catch (failure) {
            if (current()) {
                const message = errorMessage(failure, 'Не удалось сохранить настройку. Серверное значение не изменено в интерфейсе.');
                if ([401, 403].includes(status(failure) ?? 0)) denied(message);
                else if (status(failure) === 409) { row(key, { needsReview: true, error: message }); queuedRead = true; }
                else row(key, { error: message });
            }
        } finally {
            if (pending.get(key) === token) {
                pending.delete(key);
                if (current()) {
                    row(key, { saving: false });
                    if (!pending.size && queuedRead) { queuedRead = false; void refresh(); }
                }
            }
        }
    };
    return {
        activate(): void { active = true; epoch++; readSequence++; queuedRead = false; pending.clear(); state = initialFeatureFlagsState(); options.onChange(state); },
        dispose(): void { active = false; epoch++; readSequence++; queuedRead = false; },
        refresh,
        save: (key: TFeatureFlagKey, enabled: boolean): Promise<void> => save(key, enabled),
        /** Повторяет сохранённый выбор только с ревизией успешно перечитанного серверного состояния. */
        retryChoice: (key: TFeatureFlagKey): Promise<void> => {
            const choice = state.rows[key].choice;
            return choice ? save(key, choice.enabled, true) : Promise.resolve();
        },
        useCurrent(key: TFeatureFlagKey): void {
            const current = owner(), existing = state.items?.find(flag => flag.key === key), choice = state.rows[key].choice;
            if (!current() || !state.items || state.loading || state.readError || pending.has(key)) return;
            if (choice && choice.reviewedRevision !== existing?.revision) return;
            row(key, { needsReview: false, error: null, saved: false, choice: undefined });
        },
    };
}
