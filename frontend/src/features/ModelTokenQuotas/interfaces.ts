/** Browser contract mirrors public quota DTOs only; no server service or provider payload is imported. */
export interface IQuotaInput {
    requestKey: string;
    expectedRevision: number;
    enabled: boolean;
    tokenLimit: number;
    periodMs: number;
}
export interface IQuotaPolicy {
    modelId: string;
    userEmail: string;
    revision: number;
    enabled: boolean;
    tokenLimit: number;
    periodMs: number;
    accountingStartedAt: string;
    updatedAt: string;
    updatedBy: string;
}
export interface IQuotaCounters {
    actualInputTokens: string | null;
    actualOutputTokens: string | null;
    chargedTokens: string;
    activeReservedTokens: string;
    unknownHeldTokens: string;
    unknownCalls: number;
    remainingTokens: string | null;
    overrunTokens: string;
    nextBudgetChangeAt: string | null;
}
export interface IQuotaView {
    modelId: string;
    userEmail: string;
    policy: IQuotaPolicy | null;
    defaults: { periodMs: number };
    counters: IQuotaCounters;
    canManage: boolean;
    featureEnabled: boolean;
    coverage: { managedText: boolean; reason: string };
}
export interface IQuotaReceipt {
    modelId: string;
    userEmail: string;
    writerEmail: string;
    requestKey: string;
    requestFingerprint: string;
    input: IQuotaInput;
    policy: IQuotaPolicy;
}
export type TPeriodUnit = 'day' | 'hour' | 'minute' | 'second' | 'millisecond';
export interface IQuotaDraft {
    enabled: boolean;
    tokenLimit: number | null;
    duration: number | null;
    unit: TPeriodUnit;
}
export interface IQuotaIdentity {
    scope: string;
    writerEmail: string;
    modelId: string;
    userEmail: string;
}
export interface IQuotaIntent extends IQuotaIdentity {
    schemaVersion: 1;
    input: IQuotaInput;
}
export interface IQuotaState {
    draft: IQuotaDraft;
    view?: IQuotaView;
    receipt?: IQuotaReceipt;
    pending?: IQuotaIntent;
    baseRevision?: number;
    busy: boolean;
    error: string;
    storageError: string;
    notice: string;
    canReplay: boolean;
    rejected: boolean;
    missing: boolean;
    conflict?: IQuotaView;
}
export type TQuotaStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface IQuotaUser {
    email: string;
    displayName: string;
    enabled: boolean;
}
