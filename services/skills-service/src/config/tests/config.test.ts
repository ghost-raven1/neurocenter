import { describe, expect, it } from 'vitest';
import { loadSkillsConfig } from '../index';

/** AD-9: config-модуль skills-service — владелец валидации числовых env; fail-fast + маскировка. */
describe('Конфигурация skills-service (AD-9)', () => {
    it('default: PORT=4200, BIND_HOST=127.0.0.1', () => {
        const { values } = loadSkillsConfig({});
        expect(values.port).toBe(4200);
        expect(values.bindHost).toBe('127.0.0.1');
    });

    it('PORT=abc — fail-fast с именем переменной', () => {
        expect(() => loadSkillsConfig({ PORT: 'abc' })).toThrow(/PORT/);
    });

    it('секреты в отчёте: значения маскированы', () => {
        const { report } = loadSkillsConfig({ NEUROCENTER_INTERNAL_TOKEN: 'token-value' });
        const token = report.find((entry) => entry.name === 'NEUROCENTER_INTERNAL_TOKEN');
        expect(token?.value).toBe('***');
        expect(JSON.stringify(report)).not.toContain('token-value');
    });
});
