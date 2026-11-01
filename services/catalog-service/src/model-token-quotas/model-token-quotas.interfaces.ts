import type { IModel } from '../models/model.interfaces';
import type { MODEL_TOKEN_QUOTA_ESTIMATE_VERSION } from './model-token-quotas.constants';

/** Token counters use decimal strings so historical aggregates never lose integer precision in JSON. */
export interface IModelTokenQuotaCounters {
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

export interface IModelTokenQuotaPolicy {
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

export interface IModelTokenQuotaView {
    modelId: string;
    userEmail: string;
    policy: IModelTokenQuotaPolicy | null;
    defaults: { periodMs: number };
    counters: IModelTokenQuotaCounters;
    canManage: boolean;
    featureEnabled: boolean;
    coverage: { managedText: boolean; reason: string };
}

export interface IModelTokenQuotaInput {
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
export interface IModelTokenQuotaReceipt {
    modelId: string;
    userEmail: string;
    writerEmail: string;
    requestKey: string;
    requestFingerprint: string;
    input: IModelTokenQuotaInput;
    policy: IModelTokenQuotaPolicy;
}

export interface IModelTokenQuotaEstimate {
    version: typeof MODEL_TOKEN_QUOTA_ESTIMATE_VERSION;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    outputBasis: 'configured-limit' | 'planning-default' | 'no-generated-output';
    modelPin: string | null;
    requestDigest: string;
    supported: boolean;
}

export interface IModelTokenQuotaAdmission {
    usageId: string;
    userEmail: string;
    model: IModel;
    estimate: IModelTokenQuotaEstimate;
}

export type TModelTokenQuotaState = 'reserved' | 'dispatched' | 'settled' | 'unknown' | 'released';
