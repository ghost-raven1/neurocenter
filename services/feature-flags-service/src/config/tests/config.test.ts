import { describe, expect, it } from 'vitest';
import { loadFeatureFlagsConfig } from '../index';

/** AD-9: config-модуль feature-flags-service — владелец валидации числовых env; fail-fast + маскировка. */
describe('Конфигурация feature-flags-service (AD-9)', () => {
    it('default: PORT=4400, BIND_HOST=127.0.0.1', () => {
        const { values } = loadFeatureFlagsConfig({});
        expect(values.port).toBe(4400);
        expect(values.bindHost).toBe('127.0.0.1');
    });

    it('PORT=abc — fail-fast с именем переменной', () => {
        expect(() => loadFeatureFlagsConfig({ PORT: 'abc' })).toThrow(/PORT/);
    });

    it('секреты в отчёте: значения маскированы', () => {
        const { report } = loadFeatureFlagsConfig({ CATALOG_PG_URL: 'postgresql://u:p@h:5432/db' });
        const url = report.find((entry) => entry.name === 'CATALOG_PG_URL');
        expect(url?.value).toBe('***');
        expect(JSON.stringify(report)).not.toContain('postgresql://u:p@h:5432/db');
    });
});
