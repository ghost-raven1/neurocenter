import type { IModel } from '../models/model.interfaces';
import { MODEL_TOKEN_QUOTA_DEFAULT_PERIOD_MS } from './model-token-quotas.constants';
import {
    type IModelTokenQuotaCounters,
    type IModelTokenQuotaInput,
    type IModelTokenQuotaPolicy,
} from './model-token-quotas.interfaces';

export interface IModelTokenQuotaPolicyRow {
    model_id: string;
    user_email: string;
    revision: number | string;
    enabled: boolean;
    token_limit: number | string;
    period_ms: number | string;
    accounting_started_at: Date | string;
    updated_at: Date | string;
    updated_by: string;
}
const iso = (value: Date | string): string =>
    value instanceof Date ? value.toISOString() : new Date(value).toISOString();
export const quotaPolicy = (row: IModelTokenQuotaPolicyRow): IModelTokenQuotaPolicy => ({
    modelId: row.model_id,
    userEmail: row.user_email,
    revision: Number(row.revision),
    enabled: row.enabled,
    tokenLimit: Number(row.token_limit),
    periodMs: Number(row.period_ms),
    accountingStartedAt: iso(row.accounting_started_at),
    updatedAt: iso(row.updated_at),
    updatedBy: row.updated_by,
});
export const quotaCoverage = (model: Pick<IModel, 'runtime' | 'capability'>) => {
    const managedText =
        model.capability === 'chat' && ['remote-openai', 'remote-ollama', 'ollama'].includes(model.runtime);
    return {
        managedText,
        reason: managedText
            ? ''
            : 'Персональный контроль пока проверен для серверных текстовых OpenAI/Ollama-вызовов. Этот канал не объявляется покрытым.',
    };
};
export const emptyQuotaCounters = (): IModelTokenQuotaCounters => ({
    actualInputTokens: '0',
    actualOutputTokens: '0',
    chargedTokens: '0',
    activeReservedTokens: '0',
    unknownHeldTokens: '0',
    unknownCalls: 0,
    remainingTokens: null,
    overrunTokens: '0',
    nextBudgetChangeAt: null,
});
/** Canonical policy receipt text contains no credentials, prompt or provider response. */
export const quotaRequestText = (
    writerEmail: string,
    modelId: string,
    userEmail: string,
    input: IModelTokenQuotaInput,
): string =>
    JSON.stringify({
        writerEmail,
        modelId,
        userEmail,
        input: {
            requestKey: input.requestKey,
            expectedRevision: input.expectedRevision,
            enabled: input.enabled,
            tokenLimit: input.tokenLimit,
            periodMs: input.periodMs,
        },
    });
export const defaultQuotaPeriod = MODEL_TOKEN_QUOTA_DEFAULT_PERIOD_MS;
