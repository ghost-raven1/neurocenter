import type { TFeatureFlagKey } from '../../../shared/feature-flags.cjs';
import type { IChatMessage } from './chat.interfaces';
import type { TChatDb } from './chat.repository';

export interface IChatLearningReceipt {
    status: 'applied' | 'empty' | 'disabled';
    projectId: string;
    agentId: string;
    revision?: number;
    digest?: string;
    entries: Array<{ id: string; key: string; version: number; sha256: string }>;
}
export interface IPreparedLearningContext {
    messages: IChatMessage[];
    receipt: IChatLearningReceipt;
    requiredFeatures: readonly TFeatureFlagKey[];
    beforeInference(): Promise<void>;
    assertAuthorized(db?: TChatDb): Promise<void>;
}
