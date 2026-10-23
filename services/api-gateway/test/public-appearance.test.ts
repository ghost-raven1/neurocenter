import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyHttpFixture } from './proxy-http.fixture';

describe.sequential('Public card appearance through the actual gateway', () => {
    let fixture: Awaited<ReturnType<typeof proxyHttpFixture>>;
    beforeEach(async () => { vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'qa-proxy-internal'); fixture = await proxyHttpFixture(); fixture.state.authStatus = 401; });
    afterEach(async () => { await fixture.close(); vi.unstubAllEnvs(); });
    it('reveals only one visual decision before sign-in without forwarding client authority', async () => {
        const result = await fixture.send('/api/ui/appearance?projectId=private', { headers: { 'x-neurocenter-internal': 'untrusted', authorization: 'Bearer private' } });
        expect(result.status).toBe(200); expect(result.body).toEqual({ cardDepthEnabled: true, neuralBackgroundEnabled: true, available: true });
        expect(result.headers.get('cache-control')).toBe('no-store');
        expect(fixture.calls.map(call => call.path)).toEqual(['/internal/feature-flags/evaluated']);
        expect(fixture.calls[0].headers['x-neurocenter-internal']).toBe('qa-proxy-internal');
        expect(fixture.calls[0].headers.authorization).toBeUndefined(); expect(fixture.calls[0].url).not.toContain('private');
    });
    it('honours disabled appearance and treats unavailable flags as a static page', async () => {
        fixture.state.flags.card_depth_effect = false;
        expect((await fixture.send('/api/ui/appearance')).body).toEqual({ cardDepthEnabled: false, neuralBackgroundEnabled: true, available: true });
        fixture.state.flagsStatus = 500;
        expect((await fixture.send('/api/ui/appearance')).body).toEqual({ cardDepthEnabled: false, neuralBackgroundEnabled: false, available: false });
    });
    it('can disable the background independently of card motion', async () => {
        fixture.state.flags.neural_background = false;
        expect((await fixture.send('/api/ui/appearance')).body).toEqual({ cardDepthEnabled: true, neuralBackgroundEnabled: false, available: true });
    });
    it.each([['POST', '/api/ui/appearance'], ['GET', '/api/ui/appearance/'], ['GET', '/api/ui/%61ppearance']])('does not grant a public bypass to %s %s', async (method, route) => {
        expect((await fixture.send(route, { method })).status).toBe(401);
        expect(fixture.calls.some(call => call.kind === 'flags')).toBe(false);
    });
});
