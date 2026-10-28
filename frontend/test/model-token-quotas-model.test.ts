import {createHash, webcrypto} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {checkedQuotaReceipt, checkedQuotaView, formatTokens, quotaDraft, quotaFingerprint, quotaInput, quotaRequestText} from '../src/features/ModelTokenQuotas/model';
import {identity, input, key, receipt, view} from './model-token-quotas.fixture';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
describe('Public quota identity, precision and duration', () => {
    it('preserves decimal precision and unknown actual tokens instead of fabricating zero', () => {
        const value = view(); value.counters.actualInputTokens = null; value.counters.actualOutputTokens = '900719925474099300000';
        expect(checkedQuotaView(value, identity).counters).toEqual(value.counters);
        expect(formatTokens(value.counters.actualOutputTokens)).toBe('900\u00a0719\u00a0925\u00a0474\u00a0099\u00a0300\u00a0000');
        expect(() => checkedQuotaView({...value, userEmail: 'other@example.test'}, identity)).toThrow('не соответствуют');
        expect(() => checkedQuotaView({...value, counters: {...value.counters, chargedTokens: 0}}, identity)).toThrow('счётчик');
    });
    it('uses exact independent token durations from one millisecond through365days', () => {
        expect(quotaInput({enabled: true, tokenLimit: 1, duration: 365, unit: 'day'}, 0, key).periodMs).toBe(31536000000);
        expect(quotaInput({enabled: false, tokenLimit: 1, duration: 1, unit: 'millisecond'}, 7, key)).toMatchObject({enabled: false, expectedRevision: 7, periodMs: 1});
        expect(() => quotaInput({enabled: true, tokenLimit: 1, duration: 366, unit: 'day'}, 0, key)).toThrow('365');
        expect(() => quotaInput({enabled: true, tokenLimit: Number.MAX_SAFE_INTEGER + 1, duration: 1, unit: 'day'}, 0, key)).toThrow('бюджет');
        expect(quotaDraft({enabled: true, tokenLimit: 10, periodMs: 86400001})).toEqual({enabled: true, tokenLimit: 10, duration: 86400001, unit: 'millisecond'});
    });
    it('matches the backend canonical UTF8 contract, not object iteration or a fresh view', async () => {
        const canonical = '{"writerEmail":"admin@example.test","modelId":"model-a","userEmail":"new-user@example.test","input":{"requestKey":"11111111-1111-4111-8111-111111111111","expectedRevision":0,"enabled":true,"tokenLimit":10000,"periodMs":86400000}}';
        expect(quotaRequestText(identity, input())).toBe(canonical);
        expect(await quotaFingerprint(identity, input())).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'));
    });
    it('rejects another writer, target, body, digest or policy even when the request key matches', async () => {
        const ack = await receipt(); await expect(checkedQuotaReceipt(ack, identity, input())).resolves.toEqual(ack);
        for (const patch of [{writerEmail: 'other@example.test'}, {modelId: 'other'}, {userEmail: 'other@example.test'}, {input: input({tokenLimit: 20})}, {requestFingerprint: '0'.repeat(64)}, {policy: {...ack.policy, revision: 99}}, {policy: {...ack.policy, tokenLimit: 999}}]) await expect(checkedQuotaReceipt({...ack, ...patch}, identity, input())).rejects.toThrow();
    });
});
