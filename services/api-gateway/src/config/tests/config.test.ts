import { describe, expect, it } from 'vitest';
import { loadGatewayConfig } from '../index';

/** AD-9: config-модуль api-gateway — владелец валидации числовых/лимитных env; fail-fast + маскировка секретов. */
describe('Конфигурация api-gateway (AD-9)', () => {
    it('default: PORT=4000, BIND_HOST=127.0.0.1, MCP-пул 4/8/2/4, TTL 60s', () => {
        const { values } = loadGatewayConfig({});
        expect(values).toEqual({
            port: 4000,
            bindHost: '127.0.0.1',
            mcpHostMax: 4,
            mcpHostMaxPerProject: 8,
            mcpHostMaxPerDevice: 2,
            mcpHostMaxChannels: 4,
            mcpHostAuthzTtlMs: 60000,
        });
    });

    it('NaN-дыра закрыта: NEUROCENTER_MCP_HOST_MAX=abc — fail-fast с именем переменной', () => {
        expect(() => loadGatewayConfig({ NEUROCENTER_MCP_HOST_MAX: 'abc' })).toThrow(/NEUROCENTER_MCP_HOST_MAX/);
    });

    it.each([
        ['NEUROCENTER_MCP_HOST_MAX', '0'],
        ['NEUROCENTER_MCP_HOST_MAX', '-1'],
        ['NEUROCENTER_MCP_HOST_MAX', '1.5'],
        ['NEUROCENTER_MCP_HOST_MAX', '1e999'],
        ['NEUROCENTER_MCP_HOST_MAX', 'Infinity'],
        ['NEUROCENTER_MCP_HOST_MAX_PER_PROJECT', 'abc'],
        ['NEUROCENTER_MCP_HOST_MAX_PER_DEVICE', 'abc'],
        ['NEUROCENTER_MCP_HOST_MAX_CHANNELS', 'abc'],
    ])('%s=%s — fail-fast', (name, raw) => {
        expect(() => loadGatewayConfig({ [name]: raw })).toThrow(new RegExp(name));
    });

    it('TTL кэша: выше 60s / не-число — fail-fast (AD-4)', () => {
        expect(loadGatewayConfig({ NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS: '30000' }).values.mcpHostAuthzTtlMs).toBe(30000);
        for (const bad of ['0', '60001', 'abc', '1.5', '-5']) {
            expect(() => loadGatewayConfig({ NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS: bad })).toThrow(
                /NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS/,
            );
        }
    });

    it('PORT=abc — fail-fast с именем переменной', () => {
        expect(() => loadGatewayConfig({ PORT: 'abc' })).toThrow(/PORT/);
    });

    it('агрегированный отчёт: несколько ошибок сразу', () => {
        try {
            loadGatewayConfig({ PORT: 'abc', NEUROCENTER_MCP_HOST_MAX: '0', NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS: 'x' });
            throw new Error('Должен был бросить');
        } catch (error) {
            const message = (error as Error).message;
            expect(message).toMatch(/PORT/);
            expect(message).toMatch(/NEUROCENTER_MCP_HOST_MAX/);
            expect(message).toMatch(/NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS/);
            expect((error as { issues?: string[] }).issues).toHaveLength(3);
        }
    });

    it('секреты в отчёте: значения маскированы, имена видны', () => {
        const { report } = loadGatewayConfig({
            NEUROCENTER_MCP_HOST_SECRET: 'super-secret-value',
            NEUROCENTER_INTERNAL_TOKEN: 'internal-token-value',
        });
        const secret = report.find((entry) => entry.name === 'NEUROCENTER_MCP_HOST_SECRET');
        const token = report.find((entry) => entry.name === 'NEUROCENTER_INTERNAL_TOKEN');
        expect(secret?.value).toBe('***');
        expect(secret?.masked).toBe(true);
        expect(token?.value).toBe('***');
        expect(JSON.stringify(report)).not.toContain('super-secret-value');
        expect(JSON.stringify(report)).not.toContain('internal-token-value');
    });

    it('dev-режим валидирует (не только production): пустой NODE_ENV даёт fail-fast на invalid', () => {
        expect(() => loadGatewayConfig({ PORT: 'not-a-port' })).toThrow(/PORT/);
    });
});
