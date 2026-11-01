import type { TFeatureFlagKey } from '../../../shared/feature-flags.cjs';
import { AsyncLocalStorage } from 'node:async_hooks';

export const MODEL_USAGE_PURPOSES = [
    'chat',
    'agent',
    'compaction',
    'project-search',
    'device-embedding',
    'reindex',
    'learning',
    'direct',
    'verification',
    'research',
] as const;
export type TModelUsagePurpose = (typeof MODEL_USAGE_PURPOSES)[number];
/** Only a pre-dispatch gate, or an atomic cancellation with no dispatch marker, may use this classification. */
export class ModelDispatchNotStarted extends Error {}
export interface IProviderWireLease {
    apiKey?: string;
    assertCurrent?: () => void;
    release: () => Promise<void>;
}
/** Created only by the trusted remote owner; the literal fetch consumes and releases the acquired lease. */
export interface IProviderWireGuard {
    acquire: (signal?: AbortSignal) => Promise<IProviderWireLease>;
    current?: IProviderWireLease;
}
export interface IModelUsageContext {
    purpose: TModelUsagePurpose;
    actorEmail?: string | null;
    actorRole?: string | null;
    projectId?: string | null;
    agentId?: string | null;
    turnId?: string | null;
    operationId?: string | null;
    privateProjectChatRoomId?: string | null;
    requiredFeatures?: readonly TFeatureFlagKey[];
    beforeInference?: () => Promise<void>;
    beforeDispatch?: () => Promise<void>;
    dispatchOnlyFeatures?: readonly TFeatureFlagKey[];
    providerWire?: IProviderWireGuard;
}
const context = new AsyncLocalStorage<IModelUsageContext>();
/** Only trusted server call sites attach attribution; request bodies and model content are never copied. */
export function withModelUsage<T>(value: IModelUsageContext, action: () => T): T {
    return context.run({ ...context.getStore(), ...value }, action);
}
export function currentModelUsage(): IModelUsageContext {
    return context.getStore() ?? { purpose: 'direct' };
}
