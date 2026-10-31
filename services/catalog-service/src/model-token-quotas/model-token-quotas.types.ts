import type { IModel } from '../models/model.types';

export const MODEL_TOKEN_QUOTA_DEFAULT_PERIOD_MS = 86400000;
export const MODEL_TOKEN_QUOTA_MAX_PERIOD_MS = 365 * MODEL_TOKEN_QUOTA_DEFAULT_PERIOD_MS;
export const MODEL_TOKEN_QUOTA_DEFAULT_OUTPUT_ESTIMATE = 4096;
export const MODEL_TOKEN_QUOTA_ESTIMATE_VERSION = 'server-text-v1' as const;

/** Token counters use decimal strings so historical aggregates never lose integer precision in JSON. */
export interface ModelTokenQuotaCounters {
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
export interface ModelTokenQuotaPolicy {
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
export interface ModelTokenQuotaView {
    modelId: string;
    userEmail: string;
    policy: ModelTokenQuotaPolicy | null;
    defaults: { periodMs: number };
    counters: ModelTokenQuotaCounters;
    canManage: boolean;
    featureEnabled: boolean;
    coverage: { managedText: boolean; reason: string };
}
export interface ModelTokenQuotaInput {
    /** Stable UUID v1-v5, reused only for an exact explicit retry of this intent. */
    requestKey: string;
    /** Nonnegative safe integer; zero creates the first policy. */
    expectedRevision: number;
    enabled: boolean;
    /** Positive safe integer. Admission counts full known actual, active reserve and unknown holds. */
    tokenLimit: number;
    /** Integer duration from 1 through 31536000000 ms (365 days), independent of request-rate limits. */
    periodMs: number;
}
/** A saved mutation is immutable proof, distinct from a fresh balance read. */
export interface ModelTokenQuotaReceipt {
    modelId: string;
    userEmail: string;
    writerEmail: string;
    requestKey: string;
    requestFingerprint: string;
    input: ModelTokenQuotaInput;
    policy: ModelTokenQuotaPolicy;
}
export interface ModelTokenQuotaEstimate {
    version: typeof MODEL_TOKEN_QUOTA_ESTIMATE_VERSION;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    outputBasis: 'configured-limit' | 'planning-default' | 'no-generated-output';
    modelPin: string | null;
    requestDigest: string;
    supported: boolean;
}
export interface ModelTokenQuotaAdmission {
    usageId: string;
    userEmail: string;
    model: IModel;
    estimate: ModelTokenQuotaEstimate;
}
export type ModelTokenQuotaState = 'reserved' | 'dispatched' | 'settled' | 'unknown' | 'released';
