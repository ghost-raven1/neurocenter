import type {PeriodUnit, QuotaCounters, QuotaDraft, QuotaIdentity, QuotaInput, QuotaPolicy, QuotaReceipt, QuotaState, QuotaView} from './types';

export const QUOTA_DAY_MS = 86400000, QUOTA_MAX_PERIOD_MS = 365 * QUOTA_DAY_MS;
export const periodUnits: Record<PeriodUnit, number> = {day: QUOTA_DAY_MS, hour: 3600000, minute: 60000, second: 1000, millisecond: 1};
export const initialQuotaState = (): QuotaState => ({draft: {enabled: true, tokenLimit: null, duration: 1, unit: 'day'}, busy: false, error: '', storageError: '', notice: '', canReplay: false, rejected: false, missing: false});
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) && value.length <= 128;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const quotaEmail = (value: string): string => value.trim().toLowerCase();
export const sameInput = (a: QuotaInput, b: QuotaInput): boolean => a.requestKey === b.requestKey && a.expectedRevision === b.expectedRevision && a.enabled === b.enabled && a.tokenLimit === b.tokenLimit && a.periodMs === b.periodMs;
export function checkedInput(value: unknown): QuotaInput {
    if (!object(value) || Object.keys(value).sort().join(',') !== 'enabled,expectedRevision,periodMs,requestKey,tokenLimit' || !uuid(value.requestKey) || !integer(value.expectedRevision) || typeof value.enabled !== 'boolean' || !integer(value.tokenLimit, 1) || !integer(value.periodMs, 1) || value.periodMs > QUOTA_MAX_PERIOD_MS) throw Error('Некорректный сохранённый запрос квоты.');
    return {requestKey: value.requestKey, expectedRevision: value.expectedRevision, enabled: value.enabled, tokenLimit: value.tokenLimit, periodMs: value.periodMs};
}
function policy(value: unknown, identity: QuotaIdentity): QuotaPolicy {
    if (!object(value) || value.modelId !== identity.modelId || value.userEmail !== identity.userEmail || !integer(value.revision, 1) || typeof value.enabled !== 'boolean' || !integer(value.tokenLimit, 1) || !integer(value.periodMs, 1) || value.periodMs > QUOTA_MAX_PERIOD_MS || !date(value.accountingStartedAt) || !date(value.updatedAt) || typeof value.updatedBy !== 'string') throw Error('Сервер вернул некорректную политику квоты.');
    return value as unknown as QuotaPolicy;
}
/** Decimal counters remain strings throughout presentation; unknown usage never becomes zero. */
export function checkedQuotaView(value: unknown, identity: QuotaIdentity): QuotaView {
    if (!object(value) || value.modelId !== identity.modelId || value.userEmail !== identity.userEmail || !object(value.defaults) || !integer(value.defaults.periodMs, 1) || value.defaults.periodMs > QUOTA_MAX_PERIOD_MS || typeof value.canManage !== 'boolean' || typeof value.featureEnabled !== 'boolean' || !object(value.coverage) || typeof value.coverage.managedText !== 'boolean' || typeof value.coverage.reason !== 'string' || !object(value.counters)) throw Error('Сведения квоты не соответствуют выбранным модели и пользователю.');
    const counters = value.counters;
    for (const key of ['actualInputTokens', 'actualOutputTokens']) if (!(counters[key] === null || decimal(counters[key]))) throw Error('Некорректный фактический расход.');
    for (const key of ['chargedTokens', 'activeReservedTokens', 'unknownHeldTokens', 'overrunTokens']) if (!decimal(counters[key])) throw Error('Некорректный счётчик токенов.');
    if (!(counters.remainingTokens === null || decimal(counters.remainingTokens)) || !integer(counters.unknownCalls) || !(counters.nextBudgetChangeAt === null || date(counters.nextBudgetChangeAt))) throw Error('Некорректное состояние бюджета.');
    return {modelId: identity.modelId, userEmail: identity.userEmail, policy: value.policy === null ? null : policy(value.policy, identity), defaults: {periodMs: value.defaults.periodMs}, counters: counters as unknown as QuotaCounters, canManage: value.canManage, featureEnabled: value.featureEnabled, coverage: {managedText: value.coverage.managedText, reason: value.coverage.reason}};
}
/** Identical canonical UTF8 text to the public backend receipt contract, without auth role or provider data. */
export function quotaRequestText(identity: QuotaIdentity, input: QuotaInput): string {
    return JSON.stringify({writerEmail: identity.writerEmail, modelId: identity.modelId, userEmail: identity.userEmail, input: {requestKey: input.requestKey, expectedRevision: input.expectedRevision, enabled: input.enabled, tokenLimit: input.tokenLimit, periodMs: input.periodMs}});
}
export async function quotaFingerprint(identity: QuotaIdentity, input: QuotaInput): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(quotaRequestText(identity, input)));
    return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function checkedQuotaReceipt(value: unknown, identity: QuotaIdentity, expected: QuotaInput): Promise<QuotaReceipt> {
    if (!object(value) || value.modelId !== identity.modelId || value.userEmail !== identity.userEmail || value.writerEmail !== identity.writerEmail || value.requestKey !== expected.requestKey || !sameInput(checkedInput(value.input), expected) || value.requestFingerprint !== await quotaFingerprint(identity, expected)) throw Error('Подтверждение не соответствует сохранённому запросу. Исходный запрос оставлен для восстановления.');
    const saved = policy(value.policy, identity);
    if (saved.revision !== expected.expectedRevision + 1 || saved.enabled !== expected.enabled || saved.tokenLimit !== expected.tokenLimit || saved.periodMs !== expected.periodMs || saved.updatedBy !== identity.writerEmail) throw Error('Подтверждение содержит другую политику. Сохранённый запрос не удалён.');
    return {modelId: identity.modelId, userEmail: identity.userEmail, writerEmail: identity.writerEmail, requestKey: expected.requestKey, requestFingerprint: value.requestFingerprint as string, input: checkedInput(value.input), policy: saved};
}
export function quotaDraft(value: Pick<QuotaPolicy, 'enabled' | 'tokenLimit' | 'periodMs'>): QuotaDraft {
    const unit = (Object.keys(periodUnits) as PeriodUnit[]).find(key => value.periodMs % periodUnits[key] === 0)!;
    return {enabled: value.enabled, tokenLimit: value.tokenLimit, duration: value.periodMs / periodUnits[unit], unit};
}
export function quotaInput(draft: QuotaDraft, expectedRevision: number, requestKey: string): QuotaInput {
    if (draft.duration === null || !Number.isSafeInteger(draft.duration) || draft.duration < 1 || !Object.prototype.hasOwnProperty.call(periodUnits, draft.unit)) throw Error('Укажите целый положительный период.');
    try {return checkedInput({requestKey, expectedRevision, enabled: draft.enabled, tokenLimit: draft.tokenLimit, periodMs: draft.duration * periodUnits[draft.unit]});}
    catch {throw Error('Укажите положительный целый бюджет и период до 365 дней.');}
}
export const formatTokens = (value: string): string => value.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
