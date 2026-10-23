import type { FeatureFlagKey } from '../../../shared/feature-flags.cjs';
import { AsyncLocalStorage } from 'node:async_hooks';

export const MODEL_USAGE_PURPOSES = ['chat', 'agent', 'compaction', 'project-search', 'device-embedding', 'reindex', 'learning', 'direct', 'verification', 'research'] as const;
export type ModelUsagePurpose = typeof MODEL_USAGE_PURPOSES[number];
export interface ModelUsageContext { purpose: ModelUsagePurpose; actorEmail?: string | null; actorRole?:string|null; projectId?: string | null; agentId?: string | null; turnId?: string | null; operationId?: string | null; privateProjectChatRoomId?: string | null; requiredFeatures?: readonly FeatureFlagKey[]; beforeInference?: () => Promise<void> }
const context = new AsyncLocalStorage<ModelUsageContext>();
/** Only trusted server call sites attach attribution; request bodies and model content are never copied. */
export function withModelUsage<T>(value: ModelUsageContext, action: () => T): T { return context.run({ ...context.getStore(), ...value }, action); }
export function currentModelUsage(): ModelUsageContext { return context.getStore() ?? { purpose: 'direct' }; }
