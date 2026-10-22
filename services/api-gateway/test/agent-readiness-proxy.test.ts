import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserHeaders, deviceHeaders, proxyHttpFixture } from './proxy-http.fixture';

const base = '/api/projects/prj-qa/agents';
const trial = base + '/agent-one/readiness-trials/12345678-1234-4234-8234-123456789abc';
const routes = [['GET', base + '/readiness'], ['POST', base + '/agent-one/readiness-trials'], ['GET', trial], ['POST', trial + '/cancel']];

describe.sequential('Agent trial Gateway boundary with real local HTTP peers', () => {
    let f: Awaited<ReturnType<typeof proxyHttpFixture>>;
    beforeEach(async () => { vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'qa-proxy-internal'); f = await proxyHttpFixture(); });
    afterEach(async () => { await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
    it.each(routes)('forwards authenticated %s %s privately to Catalog', async (method, route) => {
        const result = await f.send(route, { method, ...(method === 'POST' ? { body: { requestId: 'qa-trial' } } : {}) });
        expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
        expect(f.business()).toHaveLength(1); expect(f.business()[0]).toMatchObject({ kind: 'catalog', path: route, method });
        expect(JSON.parse(decodeURIComponent(String(f.business()[0].headers['x-bridge-actor'])))).toMatchObject({ email: 'owner@example.test', activeRole: 'Главный админ' });
        expect(f.calls.find(call => call.path === '/internal/access/authorize')?.body).toMatchObject({ method, path: route });
    });
    it.each(routes)('rejects a device token for %s %s before reading private trials or starting work', async (method, route) => {
        const result = await f.send(route, { method, headers: deviceHeaders, ...(method === 'POST' ? { body: {} } : {}) });
        expect(result.status).toBe(403); expect(result.headers.get('cache-control')).toBe('no-store');
        expect(f.business()).toEqual([]); expect(f.calls.some(call => call.path === '/internal/access/authorize')).toBe(false);
    });
    it.each([base + '/%72eadiness/', base + '/%61gent-one/readiness-trials', base + '/agent-one/readiness-trials/%ZZ'])('does not bypass the device boundary with %s', async route => {
        expect((await f.send(route, { method: 'GET', headers: deviceHeaders })).status).toBe(403); expect(f.business()).toEqual([]);
    });
    it('preserves service ownership denials and never caches their receipt', async () => {
        f.state.businessStatus = 404; f.state.businessPayload = { message: 'Испытание не найдено.' };
        const result = await f.send(trial); expect(result.status).toBe(404); expect(result.headers.get('cache-control')).toBe('no-store');
        expect(result.body).toEqual(f.state.businessPayload);
    });
    it('keeps recovery reads and cancellation available while business flags are off', async () => {
        for (const key of Object.keys(f.state.flags)) f.state.flags[key as keyof typeof f.state.flags] = false;
        for (const [method, route] of [['GET', base + '/readiness'], ['GET', trial], ['POST', trial + '/cancel']]) {
            const result = await f.send(route, { method, ...(method === 'POST' ? { body: { expectedRevision: 1 } } : {}) });
            expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
        }
        expect(f.calls.filter(call => call.path === '/internal/feature-flags/evaluated')).toEqual([]);
    });
    it('leaves exact replay versus fresh flag admission to the stateful trial service', async () => {
        f.state.flags.model_hosting = false;
        const result = await f.send(base + '/agent-one/readiness-trials', { method: 'POST', body: {} });
        expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store'); expect(f.business()).toHaveLength(1);
        expect(f.calls.filter(call => call.path === '/internal/feature-flags/evaluated')).toEqual([]);
    });
    it('stops a trial request when the central project authority refuses access', async () => {
        f.state.allowed = false;
        const response = await fetch(f.url + trial, { headers: browserHeaders });
        expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store'); expect(f.business()).toEqual([]);
    });
});
