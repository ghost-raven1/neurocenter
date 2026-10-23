import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceHeaders, proxyHttpFixture } from './proxy-http.fixture';
import { requiredFeatureFlags } from '../src/features/feature-flag-gate';
import { LiveService } from '../src/live/live.service';

const base = '/api/projects/prj-qa/team-chat', id = '12345678-1234-4234-8234-123456789abc';
const routes = [['GET', base], ['GET', base + '/history'], ['PUT', base + '/participants'], ['POST', base + '/messages'],
    ['POST', base + '/messages/' + id + '/retry'], ['POST', base + '/messages/' + id + '/cancel']];
describe.sequential('Shared project chat HTTP boundary', () => {
    let f: Awaited<ReturnType<typeof proxyHttpFixture>>;
    beforeEach(async () => { vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'qa-proxy-internal'); f = await proxyHttpFixture(); });
    afterEach(async () => { await f.close(); vi.unstubAllEnvs(); });
    it.each(routes)('forwards browser %s %s privately with fresh central authorization', async (method, path) => {
        const result = await f.send(path, { method, ...(method === 'GET' ? {} : { body: {} }) });
        expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
        expect(f.business()).toHaveLength(1); expect(f.business()[0]).toMatchObject({ kind: 'catalog', path, method });
        expect(f.calls.find(call => call.path === '/internal/access/authorize')?.body).toMatchObject({ path, method });
    });
    it.each(routes)('refuses device credentials for %s %s before shared messages can be read', async (method, path) => {
        const result = await f.send(path, { method, headers: deviceHeaders, ...(method === 'GET' ? {} : { body: {} }) });
        expect(result.status).toBe(403); expect(result.headers.get('cache-control')).toBe('no-store'); expect(f.business()).toEqual([]);
    });
    it('leaves exact replay, history and cancellation available OFF; the executor owns fresh admission', async () => {
        for (const key of Object.keys(f.state.flags)) f.state.flags[key as keyof typeof f.state.flags] = false;
        for (const [method, path] of routes) {
            expect(requiredFeatureFlags(method, path)).toEqual([]);
            expect((await f.send(path, { method, ...(method === 'GET' ? {} : { body: {} }) })).status).toBe(200);
        }
        expect(f.calls.filter(call => call.path === '/internal/feature-flags/evaluated')).toEqual([]);
    });
    it('respects a revoked project grant before any business call', async () => {
        f.state.allowed = false; expect((await f.send(base)).status).toBe(403); expect(f.business()).toEqual([]);
    });
    it('broadcasts only a section invalidation without message content, project or human identity', () => {
        const live = new LiveService(), sections = vi.spyOn(live, 'sections').mockImplementation(() => undefined);
        live.mutation(base + '/messages', 'alice@example.test', { content: 'private question', projectId: 'prj-secret' }, 'POST');
        expect(sections).toHaveBeenCalledExactlyOnceWith(['project_chat']);
    });
});
