import { describe, expect, it } from 'vitest';
import type { TGlobalProvidersIssue } from '@neurocenter/opencode-local-providers';
import { providerIssueExplanation, unsupportedProviderVersionExplanation } from '../presentation';

describe('safe local provider explanations', () => {
    it.each([
        ['invalid-json', 'синтаксис'],
        ['unsafe-file', 'права'],
        ['source-changed', 'журнал'],
        ['environment-override', 'окружения'],
        ['entry-limit', 'пропущена'],
        ['read-failed', 'доступность'],
        ['permission-denied', 'учётную запись'],
        ['cancelled', 'отменена'],
        ['session-unavailable', 'сессия'],
        ['unsupported-version', 'версия'],
        ['unknown', 'не подтверждён'],
    ] as const)('explains %s with a concrete next step', (issue, fragment) => {
        expect(providerIssueExplanation(issue)).toContain(fragment);
    });
    it('does not echo unknown transport text or prototype keys', () => {
        for (const value of ['secret-token-/private/auth.json', '__proto__', 'constructor']) {
            expect(providerIssueExplanation(value as TGlobalProvidersIssue)).toBe(providerIssueExplanation('unknown'));
            expect(providerIssueExplanation(value as TGlobalProvidersIssue)).not.toContain(value);
        }
    });
    it('distinguishes V2 database credentials from unsupported V1 files', () => {
        expect(unsupportedProviderVersionExplanation('2.1.2')).toContain('базе своего сервера');
        expect(unsupportedProviderVersionExplanation('1.19.5')).toContain('Текущая авторизация не подтверждена');
    });
});
