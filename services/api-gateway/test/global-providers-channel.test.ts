import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {proxyHttpFixture,deviceHeaders,jobId,lease} from './proxy-http.fixture';

describe.sequential('global provider permits and bounded completion transport',()=>{
    let f:Awaited<ReturnType<typeof proxyHttpFixture>>;
    beforeEach(async()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');f=await proxyHttpFixture();});
    afterEach(async()=>{await f.close();vi.unstubAllEnvs();});
    it('forwards the exact local permit through fresh device identity',async()=>{
        const route='/api/device-channel/opencode-global-providers/authorize',body={jobId};
        const result=await f.send(route,{method:'POST',headers:deviceHeaders,body});expect(result.status).toBe(200);
        expect(f.calls.some(call=>call.path==='/internal/device-channel/identity')).toBe(true);
        expect(f.calls.filter(call=>call.path==='/internal/device-channel/opencode-global-providers/authorize')).toMatchObject([{method:'POST',body}]);
    });
    it('cannot obtain a private local permit through a browser session',async()=>{
        const result=await f.send('/api/device-channel/opencode-global-providers/authorize',{method:'POST',body:{jobId}});
        expect(result.status).toBe(401);expect(f.calls.filter(call=>call.path==='/internal/device-channel/opencode-global-providers/authorize')).toEqual([]);
    });
    it('delivers a 512 KiB result with its envelope instead of stranding the native outbox',async()=>{
        const result={data:''};result.data='x'.repeat(512*1024-Buffer.byteLength(JSON.stringify(result)));
        expect(Buffer.byteLength(JSON.stringify(result))).toBe(512*1024);
        const body={lease,state:'succeeded',message:'Состояние прочитано.',result};
        expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(512*1024);
        const response=await f.send('/api/device-channel/jobs/'+jobId+'/complete',{method:'POST',headers:deviceHeaders,body});
        expect(response.status).toBe(200);expect(f.calls.filter(call=>call.path.endsWith('/complete'))[0].body).toEqual(body);
    });
    it('rejects an oversized envelope before device authorization or forwarding',async()=>{
        const response=await f.send('/api/device-channel/jobs/'+jobId+'/complete',{method:'POST',headers:deviceHeaders,body:{data:'x'.repeat(600*1024)}});
        expect(response.status).toBe(413);expect(f.calls).toEqual([]);
    });
});
