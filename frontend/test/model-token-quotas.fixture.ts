import {webcrypto} from 'node:crypto';
import {vi} from 'vitest';
import {createQuotaController} from '../src/features/ModelTokenQuotas/controller';
import {initialQuotaState, quotaFingerprint} from '../src/features/ModelTokenQuotas/model';
import type {QuotaIdentity, QuotaInput, QuotaReceipt, QuotaState, QuotaStorage, QuotaView} from '../src/features/ModelTokenQuotas/types';

export const identity: QuotaIdentity = {scope: 'auth-role-session-a', writerEmail: 'admin@example.test', modelId: 'model-a', userEmail: 'new-user@example.test'};
export const key = '11111111-1111-4111-8111-111111111111', nextKey = '22222222-2222-4222-8222-222222222222';
export const input = (patch: Partial<QuotaInput> = {}): QuotaInput => ({requestKey: key, expectedRevision: 0, enabled: true, tokenLimit: 10000, periodMs: 86400000, ...patch});
export const view = (patch: Partial<QuotaView> = {}): QuotaView => ({modelId: identity.modelId, userEmail: identity.userEmail, policy: null, defaults: {periodMs: 86400000}, counters: {actualInputTokens: '0', actualOutputTokens: '0', chargedTokens: '0', activeReservedTokens: '0', unknownHeldTokens: '0', unknownCalls: 0, remainingTokens: null, overrunTokens: '0', nextBudgetChangeAt: null}, canManage: true, featureEnabled: true, coverage: {managedText: true, reason: ''}, ...patch});
export async function receipt(value = input(), who = identity): Promise<QuotaReceipt> {
    return {modelId: who.modelId, userEmail: who.userEmail, writerEmail: who.writerEmail, requestKey: value.requestKey, requestFingerprint: await quotaFingerprint(who, value), input: value, policy: {modelId: who.modelId, userEmail: who.userEmail, revision: value.expectedRevision + 1, enabled: value.enabled, tokenLimit: value.tokenLimit, periodMs: value.periodMs, accountingStartedAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:01.000Z', updatedBy: who.writerEmail}};
}
export const failure = (status: number, message = 'Отказ', code?: string): unknown => ({isAxiosError: true, response: {status, data: {message, ...(code ? {code} : {})}}});
export const deferred = <T>() => {let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;}); return {promise, resolve, reject};};
export function memoryStorage() {
    const values = new Map<string, string>();
    return {values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}};
}
export function setup(options: {identity?: QuotaIdentity; storage?: QuotaStorage; initial?: QuotaView} = {}) {
    vi.stubGlobal('crypto', webcrypto);
    const who = options.identity ?? identity, storage = options.storage ?? memoryStorage();
    let state: QuotaState = initialQuotaState(), owner = true;
    const api = {read: vi.fn().mockResolvedValue(options.initial ?? view({modelId: who.modelId, userEmail: who.userEmail})), write: vi.fn(), receipt: vi.fn().mockRejectedValue(failure(404))};
    const controller = createQuotaController({...who, api, storage, captureOwner: () => () => owner, onChange: value => {state = value;}, requestKey: vi.fn().mockReturnValueOnce(key).mockReturnValue(nextKey)});
    controller.activate();
    return {controller, api, storage, state: () => state, revoke: () => {owner = false;}};
}
