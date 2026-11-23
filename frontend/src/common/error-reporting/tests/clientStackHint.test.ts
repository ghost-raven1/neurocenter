import { describe, expect, it } from 'vitest';

import {
    buildClientStackHint,
    CLIENT_STACK_HINT_MAX_BYTES,
    sanitizeClientStackHint,
    truncateToBytes,
} from '../clientStackHint';

describe('buildClientStackHint (AD-O8: кадры без значений)', () => {
    it('stack Error: первая строка (error.message) не уходит, кадры остаются', () => {
        const error = new Error('secret payload');
        error.stack = 'Error: secret payload\n    at outer() at app.js:10:5\n    at inner() at lib.js:20:9';
        const hint = buildClientStackHint(error);
        expect(hint).toBe('at outer() at app.js:10:5\nat inner() at lib.js:20:9');
        expect(hint).not.toContain('secret payload');
    });

    it('top-20 кадров, остальное обрезается', () => {
        const error = new Error('boom');
        error.stack =
            'Error: boom\n' + Array.from({ length: 30 }, (_, i) => `    at f${i}() at x.js:${i}:1`).join('\n');
        const hint = buildClientStackHint(error) as string;
        expect(hint).toContain('f0() at x.js:0:1');
        expect(hint).toContain('f19() at x.js:19:1');
        expect(hint).not.toContain('f20()');
    });

    it('trunc до 4 КБ с пометкой', () => {
        const error = new Error('long');
        error.stack =
            'Error: long\n' +
            Array.from(
                { length: 30 },
                (_, i) => `at frame_${'x'.repeat(300)}_${i}() at ${'y'.repeat(60)}.js:${i}:1`,
            ).join('\n');
        const hint = buildClientStackHint(error) as string;
        expect(new TextEncoder().encode(hint).byteLength).toBeLessThanOrEqual(CLIENT_STACK_HINT_MAX_BYTES + 20);
        expect(hint.endsWith('…[truncated]')).toBe(true);
    });

    it('не-Error причина: только тип, значение не раскрывается', () => {
        expect(buildClientStackHint('personal secret string')).toBe('Error: string');
        expect(buildClientStackHint({ data: 'object-data' })).toBe('Error: object');
        expect(buildClientStackHint(42)).toBe('Error: number');
        expect(buildClientStackHint(null)).toBe('Error: unknown');
        expect(buildClientStackHint(undefined)).toBe('Error: unknown');
    });

    it('Error без кадров (только заголовок) — null; без stack — тип причины', () => {
        const headerOnly = new Error('only header');
        headerOnly.stack = 'Error: only header';
        expect(buildClientStackHint(headerOnly)).toBeNull();
        const noStack = new Error('no stack');
        (noStack as { stack?: string }).stack = undefined;
        expect(buildClientStackHint(noStack)).toBe('Error: object');
    });
});

describe('sanitizeClientStackHint / truncateToBytes', () => {
    it('не-строка → null', () => {
        expect(sanitizeClientStackHint({ frames: [] })).toBeNull();
        expect(sanitizeClientStackHint(null)).toBeNull();
        expect(sanitizeClientStackHint('')).toBeNull();
    });

    it('пустые строки вычищаются, CRLF нормализуется', () => {
        expect(sanitizeClientStackHint('a\r\n\r\n  b  \n')).toBe('a\nb');
    });

    it('truncateToBytes не режет посреди кода и отмечает обрезку', () => {
        const value = 'я'.repeat(3000); // 6000 байт UTF-8
        const truncated = truncateToBytes(value, 4096);
        expect(truncated.endsWith('…[truncated]')).toBe(true);
        const body = truncated.slice(0, -'…[truncated]'.length);
        expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(4096);
        expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(4096 + 20);
    });

    it('короткая строка не трогается', () => {
        expect(truncateToBytes('short', 4096)).toBe('short');
    });
});
