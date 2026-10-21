import { describe, expect, it } from 'vitest';
import { chatContext, chatUsage } from '../src/model-chat/chat-context';

const message = (content: string) => ({ role: 'user', content });

describe('Saved chat context budgets', () => {
    it('Keeps unknown model capacity unknown and labels the token heuristic', () => {
        expect(chatContext([])).toEqual({ contextWindowTokens: null, reservedOutputTokens: null, estimatedInputTokens: 0, method: 'estimate',
            messageCount: 0, maxMessages: 40, maxMessageBytes: 131072, maxRequestBytes: 8388608,
            requestBytes: Buffer.byteLength(JSON.stringify({ messages: [], stream: false })), exceeded: false });
        const multilingual = 'Код const цена = "日本語 😀";';
        const result = chatContext([message(multilingual)]);
        expect(result.contextWindowTokens).toBeNull();
        expect(result.estimatedInputTokens).toBeGreaterThanOrEqual(Math.ceil(Buffer.byteLength(multilingual) / 2));
        expect(result.method).toBe('estimate');
    });
    it('Enforces a known model window with the configured output reserve without truncating messages', () => {
        const messages = [message('x'.repeat(100))], before = JSON.stringify(messages);
        const expected = chatContext(messages).estimatedInputTokens;
        expect(chatContext(messages, { contextWindowTokens: expected + 64, reservedOutputTokens: 64 }).exceeded).toBe(false);
        expect(chatContext(messages, { contextWindowTokens: expected + 63, reservedOutputTokens: 64 })).toMatchObject({ exceeded: true, reason: expect.stringContaining('Оценка') });
        expect(JSON.stringify(messages)).toBe(before);
    });
    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('Does not invent a capacity from invalid metadata %s', value => {
        expect(chatContext([message('x')], { contextWindowTokens: value, reservedOutputTokens: value })).toMatchObject({ contextWindowTokens: null, reservedOutputTokens: null, exceeded: false });
    });
    it('Respects the 40-message boundary and byte boundaries for Cyrillic text', () => {
        expect(chatContext(Array.from({ length: 40 }, () => message('x'))).exceeded).toBe(false);
        expect(chatContext(Array.from({ length: 41 }, () => message('x')))).toMatchObject({ exceeded: true, messageCount: 41, reason: expect.stringContaining('40 сообщений') });
        expect(chatContext([message('я'.repeat(65536))]).exceeded).toBe(false);
        expect(chatContext([message('я'.repeat(65537))])).toMatchObject({ exceeded: true, reason: expect.stringContaining('128 КиБ') });
    });
    it('Counts the serialized JSON exactly, including escaping, at and above 8 MiB', () => {
        const messages = [...Array.from({ length: 10 }, () => message('\u0000'.repeat(131072))), message('')];
        const remaining = 8388608 - chatContext(messages).requestBytes;
        messages[10].content = '\u0000'.repeat(Math.floor(remaining / 6)) + 'a'.repeat(remaining % 6);
        expect(chatContext(messages)).toMatchObject({ requestBytes: 8388608, exceeded: false });
        messages[10].content += 'a';
        expect(chatContext(messages)).toMatchObject({ requestBytes: 8388609, exceeded: true, reason: expect.stringContaining('8 МиБ') });
    });
});

describe('Provider reported token usage', () => {
    it('Distinguishes missing usage from real zero, and preserves partial counts', () => {
        expect(chatUsage({})).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, reported: false });
        expect(chatUsage({ prompt_eval_count: 0, eval_count: 0, usage_reported: true })).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, reported: true });
        expect(chatUsage({ prompt_eval_count: 12 })).toEqual({ inputTokens: 12, outputTokens: null, totalTokens: null, reported: true });
        expect(chatUsage({ prompt_eval_count: 12, eval_count: 9 })).toEqual({ inputTokens: 12, outputTokens: 9, totalTokens: 21, reported: true });
        expect(chatUsage({ prompt_eval_count: 0, eval_count: 0, usage_reported: false }).reported).toBe(false);
    });
    it.each([-1, 1.5, '12', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('Rejects invalid provider counters %s', value => {
        expect(chatUsage({ prompt_eval_count: value, eval_count: value, usage_reported: true })).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, reported: false });
    });
    it('Does not overflow a reported total', () => {
        expect(chatUsage({ prompt_eval_count: Number.MAX_SAFE_INTEGER, eval_count: 1 })).toEqual({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: null, reported: true });
    });
});
