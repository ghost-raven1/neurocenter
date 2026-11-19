import { describe, expect, it } from 'vitest';
import { loadOauth2BridgeConfig } from '../index';

/** AD-9: config-модуль oauth2-bridge — владелец валидации числовых env; fail-fast + маскировка. */
describe('Конфигурация oauth2-bridge (AD-9)', () => {
    it('default: PORT=22222, BIND_HOST=127.0.0.1', () => {
        const { values } = loadOauth2BridgeConfig({});
        expect(values.port).toBe(22222);
        expect(values.bindHost).toBe('127.0.0.1');
    });

    it('PORT=abc — fail-fast с именем переменной', () => {
        expect(() => loadOauth2BridgeConfig({ PORT: 'abc' })).toThrow(/PORT/);
    });

    it('SSO_DISABLE принимает true/false; прочее — fail-fast', () => {
        expect(loadOauth2BridgeConfig({ SSO_DISABLE: 'true' }).values.ssoDisable).toBe(true);
        expect(loadOauth2BridgeConfig({ SSO_DISABLE: 'false' }).values.ssoDisable).toBe(false);
        expect(() => loadOauth2BridgeConfig({ SSO_DISABLE: 'yes' })).toThrow(/SSO_DISABLE/);
    });

    it('секреты в отчёте: значения маскированы', () => {
        const { report } = loadOauth2BridgeConfig({ SSO_CLIENT_SECRET: 'secret-value' });
        const secret = report.find((entry) => entry.name === 'SSO_CLIENT_SECRET');
        expect(secret?.value).toBe('***');
        expect(JSON.stringify(report)).not.toContain('secret-value');
    });

    it('агрегированный отчёт: несколько ошибок сразу', () => {
        try {
            loadOauth2BridgeConfig({ PORT: 'x', SSO_DISABLE: 'maybe' });
            throw new Error('Должен был бросить');
        } catch (error) {
            const message = (error as Error).message;
            expect(message).toMatch(/PORT/);
            expect(message).toMatch(/SSO_DISABLE/);
        }
    });
});
