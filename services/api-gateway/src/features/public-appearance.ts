import type { AxiosInstance } from 'axios';
import { readEvaluatedFeatureFlags } from './feature-flag-gate';

/** Login needs only visual decisions; identities and other feature settings stay private. */
export async function publicAppearance(http: Pick<AxiosInstance, 'get'>, base: string) {
    try {
        const { flags } = await readEvaluatedFeatureFlags(http, base);
        return {
            cardDepthEnabled: flags.card_depth_effect,
            neuralBackgroundEnabled: flags.neural_background,
            available: true,
        };
    } catch {
        return { cardDepthEnabled: false, neuralBackgroundEnabled: false, available: false };
    }
}
