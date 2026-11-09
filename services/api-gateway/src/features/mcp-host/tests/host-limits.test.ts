import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHZ_CACHE_TTL_CAP_MS, McpHostService, parseMcpHostLimits } from '../host';

/** AD-4/AD-9: NaN-дыра `Math.max(1, Number('abc'))` закрыта — invalid-значение не даёт неограниченный пул. */
describe('Квоты пула MCP-хостов (AD-4, AD-9)', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('default: глобальный 4, per-project 8, per-device 2, каналы 4, кэш 60s', () => {
        expect(parseMcpHostLimits({})).toEqual({
            maxHosts: 4,
            maxPerProject: 8,
            maxPerDevice: 2,
            maxChannelsPerHost: 4,
            authzCacheTtlMs: AUTHZ_CACHE_TTL_CAP_MS,
        });
    });

    it.each(['abc', '0', '-1', '1.5', 'NaN', 'Infinity'])(
        'NEUROCENTER_MCP_HOST_MAX=%s — fail-fast (не неограниченный пул)',
        (raw) => {
            expect(() => parseMcpHostLimits({ NEUROCENTER_MCP_HOST_MAX: raw })).toThrow(/NEUROCENTER_MCP_HOST_MAX/);
        },
    );

    it('пустое NEUROCENTER_MCP_HOST_MAX — default 4', () => {
        expect(parseMcpHostLimits({ NEUROCENTER_MCP_HOST_MAX: '' }).maxHosts).toBe(4);
    });

    it.each([
        ['NEUROCENTER_MCP_HOST_MAX_PER_PROJECT', 'maxPerProject'],
        ['NEUROCENTER_MCP_HOST_MAX_PER_DEVICE', 'maxPerDevice'],
        ['NEUROCENTER_MCP_HOST_MAX_CHANNELS', 'maxChannelsPerHost'],
    ] as const)('%s=abc — fail-fast', (name, key) => {
        expect(() => parseMcpHostLimits({ [name]: 'abc' })).toThrow(new RegExp(name));
        expect(parseMcpHostLimits({ [name]: '7' })[key]).toBe(7);
    });

    it('TTL кэша: default 60s, валидное <60s, выше 60s/не-число — fail-fast (AD-4: окно отзыва ≤60s)', () => {
        expect(parseMcpHostLimits({}).authzCacheTtlMs).toBe(60000);
        expect(parseMcpHostLimits({ NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS: '30000' }).authzCacheTtlMs).toBe(30000);
        for (const bad of ['0', '60001', 'abc', '-5', '1.5']) {
            expect(() => parseMcpHostLimits({ NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS: bad })).toThrow(
                /NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS/,
            );
        }
    });

    it('старт сервиса (конструктор по default) с invalid-пулом — fail-fast до listen', () => {
        vi.stubEnv('NEUROCENTER_MCP_HOST_MAX', 'abc');
        expect(() => new McpHostService('http://catalog.test', 'token')).toThrow(/NEUROCENTER_MCP_HOST_MAX/);
    });

    it('явные лимиты конструктора не читают env', () => {
        vi.stubEnv('NEUROCENTER_MCP_HOST_MAX', 'abc');
        const service = new McpHostService('http://catalog.test', 'token', {
            maxHosts: 2,
            maxPerProject: 3,
            maxPerDevice: 1,
            maxChannelsPerHost: 2,
            authzCacheTtlMs: 1000,
        });
        expect(service).toBeInstanceOf(McpHostService);
        void service.onModuleDestroy();
    });
});
