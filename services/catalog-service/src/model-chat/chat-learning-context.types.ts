import type { FeatureFlagKey } from '../../../shared/feature-flags.cjs';
import type { ChatMessage } from './chat.types';
import type { ChatDb } from './chat.repository';

export interface ChatLearningReceipt {
    status: 'applied' | 'empty' | 'disabled';
    projectId: string; agentId: string; revision?: number; digest?: string;
    entries: Array<{ id: string; key: string; version: number; sha256: string }>;
}
export interface PreparedLearningContext {
    messages: ChatMessage[]; receipt: ChatLearningReceipt; requiredFeatures: readonly FeatureFlagKey[];
    beforeInference(): Promise<void>;
    assertAuthorized(db?: ChatDb): Promise<void>;
}
