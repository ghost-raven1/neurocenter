import { describe, expect, it } from 'vitest';
import {
    auditLinkForRequestId,
    describeErrorMessage,
    describeErrorLevel,
    errorStackFrames,
    formatErrorTime,
} from '../errorPresentation';

describe('describeErrorMessage', () => {
    it('maps every known fixed classifier to a human label', () => {
        expect(describeErrorMessage('client-render-error')).toBe('Ошибка интерфейса (render)');
        expect(describeErrorMessage('client-uncaught-error')).toBe('Неперехваченная ошибка');
        expect(describeErrorMessage('client-unhandled-rejection')).toBe('Необработанное исключение (rejection)');
        expect(describeErrorMessage('crash.uncaughtException')).toBe('Сбой сервиса (uncaught exception)');
        expect(describeErrorMessage('crash.unhandledRejection')).toBe('Сбой сервиса (unhandled rejection)');
    });

    it('passes an unknown classifier through without guessing', () => {
        expect(describeErrorMessage('client-new-kind')).toBe('client-new-kind');
    });

    it('falls back for a missing classifier', () => {
        expect(describeErrorMessage('')).toBe('Классификатор не указан');
    });
});

describe('describeErrorLevel', () => {
    it('labels error and critical levels distinctly', () => {
        expect(describeErrorLevel('error')).toEqual({ label: 'Ошибка', color: 'red' });
        expect(describeErrorLevel('critical')).toEqual({ label: 'Критическая', color: 'volcano' });
    });
});

describe('formatErrorTime', () => {
    it('formats a valid ISO timestamp', () => {
        const rendered = formatErrorTime('2026-11-22T10:30:00.000Z');
        expect(rendered).not.toBe('Дата не указана');
        expect(rendered).toContain('22');
    });

    it('answers «Дата не указана» for missing or unparseable values', () => {
        expect(formatErrorTime(null)).toBe('Дата не указана');
        expect(formatErrorTime('')).toBe('Дата не указана');
        expect(formatErrorTime('не-дата')).toBe('Дата не указана');
    });
});

describe('errorStackFrames', () => {
    it('returns no frames for a missing hint', () => {
        expect(errorStackFrames(null)).toEqual([]);
        expect(errorStackFrames('')).toEqual([]);
    });

    it('splits frames by line, trims and drops empties', () => {
        expect(
            errorStackFrames('component: NeurocenterShell\n  at render (app.js:1)\n\n   \nat more (x.js:2)'),
        ).toEqual(['component: NeurocenterShell', 'at render (app.js:1)', 'at more (x.js:2)']);
    });
});

describe('auditLinkForRequestId', () => {
    it('builds an audit search link for a plain requestId', () => {
        expect(auditLinkForRequestId('req-123')).toBe('/audit?search=req-123');
    });

    it('encodes unsafe characters in the search query', () => {
        expect(auditLinkForRequestId('req 1/2')).toBe('/audit?search=req%201%2F2');
    });
});
