/** Browser contract mirrors public quota DTOs only; no server service or provider payload is imported. */
export interface QuotaInput {requestKey: string; expectedRevision: number; enabled: boolean; tokenLimit: number; periodMs: number;}
export interface QuotaPolicy {modelId: string; userEmail: string; revision: number; enabled: boolean; tokenLimit: number; periodMs: number; accountingStartedAt: string; updatedAt: string; updatedBy: string;}
export interface QuotaCounters {actualInputTokens: string | null; actualOutputTokens: string | null; chargedTokens: string; activeReservedTokens: string; unknownHeldTokens: string; unknownCalls: number; remainingTokens: string | null; overrunTokens: string; nextBudgetChangeAt: string | null;}
export interface QuotaView {modelId: string; userEmail: string; policy: QuotaPolicy | null; defaults: {periodMs: number}; counters: QuotaCounters; canManage: boolean; featureEnabled: boolean; coverage: {managedText: boolean; reason: string};}
export interface QuotaReceipt {modelId: string; userEmail: string; writerEmail: string; requestKey: string; requestFingerprint: string; input: QuotaInput; policy: QuotaPolicy;}
export type PeriodUnit = 'day' | 'hour' | 'minute' | 'second' | 'millisecond';
export interface QuotaDraft {enabled: boolean; tokenLimit: number | null; duration: number | null; unit: PeriodUnit;}
export interface QuotaIdentity {scope: string; writerEmail: string; modelId: string; userEmail: string;}
export interface QuotaIntent extends QuotaIdentity {schemaVersion: 1; input: QuotaInput;}
export interface QuotaState {draft: QuotaDraft; view?: QuotaView; receipt?: QuotaReceipt; pending?: QuotaIntent; baseRevision?: number; busy: boolean; error: string; storageError: string; notice: string; canReplay: boolean; rejected: boolean; missing: boolean; conflict?: QuotaView;}
export interface QuotaApi {read: (signal: AbortSignal) => Promise<unknown>; write: (input: QuotaInput, signal: AbortSignal) => Promise<unknown>; receipt: (requestKey: string, signal: AbortSignal) => Promise<unknown>;}
export type QuotaStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface QuotaUser {email: string; displayName: string; enabled: boolean;}
