import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { FEATURE_FLAGS, FEATURE_FLAG_KEYS, defaultFeatureFlags, isFeatureFlagKey } from '../../shared/feature-flags.cjs';
import { createObservability } from '../../shared/observability.cjs';

const require = createRequire(import.meta.url);
const { validateProduction } = require('../../shared/runtime.cjs') as { validateProduction: (environment: Record<string, string>, service: string) => void };
const production = () => ({ NODE_ENV: 'production', PANEL_URL: 'https://panel.example.invalid', NEUROCENTER_INTERNAL_TOKEN: 'a'.repeat(64),
    CATALOG_PG_URL: 'postgresql://nc_catalog:fixture@postgres:5432/catalog', CATALOG_SERVICE_URL: 'http://catalog-service:4100' });

describe('Общие контракты сервиса переключателей', () => {
    it('Реестр неизменяемый, содержит согласованные функции продукта', () => {
        expect(FEATURE_FLAG_KEYS).toHaveLength(37); expect(new Set(FEATURE_FLAG_KEYS).size).toBe(37);
        expect(Object.isFrozen(FEATURE_FLAGS)).toBe(true); expect(FEATURE_FLAGS.every(Object.isFrozen)).toBe(true);
        expect(isFeatureFlagKey('rag_sync')).toBe(true); expect(isFeatureFlagKey('custom')).toBe(false);
        const flags = defaultFeatureFlags(); flags.rag_sync = false;
        expect(defaultFeatureFlags().rag_sync).toBe(true);
        expect(defaultFeatureFlags().opencode_providers).toBe(false);expect(defaultFeatureFlags().codex_connector).toBe(false);
    });

    it('Production принимает новый сервис только с безопасными обязательными настройками', () => {
        expect(() => validateProduction(production(), 'feature-flags-service')).not.toThrow();
        for (const key of ['CATALOG_PG_URL', 'CATALOG_SERVICE_URL', 'NEUROCENTER_INTERNAL_TOKEN', 'PANEL_URL']) {
            const settings: Record<string, string> = production(); delete settings[key];
            expect(() => validateProduction(settings, 'feature-flags-service')).toThrow();
        }
        expect(() => validateProduction({ ...production(), SSO_DISABLE: 'true' }, 'feature-flags-service')).toThrow();
        expect(() => validateProduction({ ...production(), CATALOG_SERVICE_URL: 'http://user:password@catalog-service:4100/private' }, 'feature-flags-service')).toThrow();
    });

    it('Метрики используют отдельную фиксированную метку сервиса', () => {
        const metrics = createObservability({ service: 'feature-flags-service' }).render();
        expect(metrics).toContain('service="feature-flags-service"');
        expect(metrics).not.toContain('fixture@postgres');
    });
});
