import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {deviceHeaders,jobId,proxyHttpFixture} from './proxy-http.fixture';
import {requiredFeatureFlags} from '../src/features/feature-flag-gate';

const route='/api/device-jobs/requests/'+jobId;

/** Exact receipt reads remain private and uncached, including a missing or denied result. */
describe.sequential('Device request receipt through the browser gateway',()=>{
    let f:Awaited<ReturnType<typeof proxyHttpFixture>>;
    beforeEach(async()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');f=await proxyHttpFixture();});
    afterEach(async()=>{await f.close();vi.unstubAllEnvs();});
    it.each([200,404])('does not cache a receipt response with upstream status %s',async status=>{
        const receipt={requestKey:jobId,requestFingerprint:'c'.repeat(64),job:{id:'saved-job',projectId:'prj-qa',state:'succeeded'}};
        f.state.businessStatus=status;f.state.businessPayload=status===200?receipt:{message:'Not found'};
        f.state.businessHeaders={'cache-control':'public, max-age=3600'};
        const result=await f.send(route);expect(result.status).toBe(status);expect(result.headers.get('cache-control')).toBe('no-store');
        expect(result.body).toEqual(f.state.businessPayload);expect(f.business()).toHaveLength(1);
        expect(f.business()[0]).toMatchObject({kind:'catalog',path:route,method:'GET'});expect(f.live.mutation).not.toHaveBeenCalled();
    });
    it('reads a saved request with all business flags disabled without evaluating or starting work',async()=>{
        for(const key of Object.keys(f.state.flags))f.state.flags[key as keyof typeof f.state.flags]=false;
        expect(requiredFeatureFlags('GET',route)).toEqual([]);
        expect((await f.send(route)).status).toBe(200);
        expect(f.calls.filter(call=>call.path==='/internal/feature-flags/evaluated')).toEqual([]);
        expect(f.business().map(call=>call.method)).toEqual(['GET']);expect(f.live.mutation).not.toHaveBeenCalled();
    });
    it('requires a fresh route authorization decision and does not cache its revocation',async()=>{
        expect((await f.send(route)).status).toBe(200);f.state.allowed=false;
        const denied=await f.send(route);expect(denied.status).toBe(403);expect(denied.headers.get('cache-control')).toBe('no-store');
        expect(f.business()).toHaveLength(1);expect(f.calls.filter(call=>call.path==='/internal/access/authorize')).toHaveLength(2);
    });
    it('does not cache an expired browser session or read another receipt after it expires',async()=>{
        f.state.authStatus=401;const denied=await f.send(route);expect(denied.status).toBe(401);
        expect(denied.headers.get('cache-control')).toBe('no-store');expect(f.business()).toEqual([]);
    });
    it('does not expose browser receipts to a device credential',async()=>{
        const denied=await f.send(route,{headers:deviceHeaders});expect(denied.status).toBe(403);
        expect(denied.headers.get('cache-control')).toBe('no-store');expect(f.business()).toEqual([]);
    });
    it('does not admit a new Memory sync when its flag is disabled, while the receipt stays readable',async()=>{
        f.state.flags.project_learning_memory=false;
        const denied=await f.send('/api/device-jobs',{method:'POST',body:{kind:'sync-learning-memory',memoryMode:'sync'}});
        expect(denied.status).toBe(403);expect(f.business()).toEqual([]);
        expect((await f.send(route)).status).toBe(200);expect(f.business().map(call=>call.method)).toEqual(['GET']);
    });
});
