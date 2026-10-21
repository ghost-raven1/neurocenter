import { errorMessage } from '../../common/utils/errorMessage';
import { requireEvaluatedFeatureFlags } from './types';
import type { IEvaluatedFeatureFlags } from './types';

export interface IFeatureAvailabilityState { data: IEvaluatedFeatureFlags | null; loading: boolean; error: string | null; }
export const emptyAvailability = (): IFeatureAvailabilityState => ({ data: null, loading: false, error: null });

/** One authenticated reader rejects old owners and fails closed after an unsuccessful refresh. */
export function createAvailabilityController(options: {
    read: () => Promise<unknown>; captureOwner: () => () => boolean; onChange: (state: IFeatureAvailabilityState) => void;
}) {
    let active = false, epoch = 0, sequence = 0, state = emptyAvailability();
    const update = (changes: Partial<IFeatureAvailabilityState>): void => { state = { ...state, ...changes }; options.onChange(state); };
    return {
        activate(): void { active = true; epoch++; sequence++; state = emptyAvailability(); options.onChange(state); },
        dispose(): void { active = false; epoch++; sequence++; },
        async refresh(): Promise<void> {
            const owns = options.captureOwner(), request = ++sequence, generation = epoch;
            const current = (): boolean => active && generation === epoch && request === sequence && owns();
            if (!current()) return;
            update({ loading: true });
            try {
                const data = requireEvaluatedFeatureFlags(await options.read());
                if (current()) update({ data, error: null });
            } catch (failure) {
                if (current()) update({ data: null, error: errorMessage(failure, 'Не удалось проверить доступность функций.') });
            } finally { if (current()) update({ loading: false }); }
        },
    };
}
