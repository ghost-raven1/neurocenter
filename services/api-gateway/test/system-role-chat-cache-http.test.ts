import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {chatId,deviceHeaders,jobId,proxyHttpFixture,reply} from './proxy-http.fixture';

const root='/api/system-role-chats',dialog=root+'/'+chatId,recovery=dialog+'/requests/'+jobId;
const routes=[
    {method:'GET',path:root+'?projectId=prj-qa'},
    {method:'GET',path:dialog},
    {method:'HEAD',path:dialog},
    {method:'GET',path:recovery},
    {method:'POST',path:root},
    {method:'POST',path:dialog+'/prepare'},
    {method:'POST',path:dialog+'/turns'},
    {method:'POST',path:dialog+'/turns/'+jobId+'/cancel'},
];

/** Real Proxy/AuthGuard/Axios over local HTTP; service-owned receipts and ACL decisions are synthetic. */
describe.sequential('Private service-chat responses remain uncached across the gateway',()=>{
    let f:Awaited<ReturnType<typeof proxyHttpFixture>>;
    beforeEach(async()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');f=await proxyHttpFixture();});
    afterEach(async()=>{await f.close();vi.unstubAllEnvs();});

    it.each(routes)('protects $method $path without changing its authorized routing',async({method,path})=>{
        f.state.businessHeaders={'cache-control':'public, max-age=3600'};
        const result=await f.send(path,{method,...(method==='POST'?{body:{fixture:'private selection'}}:{})});
        expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('no-store');
        expect(f.business()).toHaveLength(1);
        expect(f.business()[0]).toMatchObject({kind:'catalog',path:path.split('?')[0],method});
    });

    it('observes a later receipt for the same missing key without starting or replaying a turn',async()=>{
        for(const key of Object.keys(f.state.flags))f.state.flags[key as keyof typeof f.state.flags]=false;
        f.state.businessStatus=404;f.state.businessPayload={message:'Receipt not committed yet'};
        const missing=await f.send(recovery);
        f.state.businessStatus=200;f.state.businessPayload={id:jobId,run:{id:chatId,state:'queued'}};
        const accepted=await f.send(recovery);
        expect([missing.status,accepted.status]).toEqual([404,200]);
        expect([missing.headers.get('cache-control'),accepted.headers.get('cache-control')]).toEqual(['no-store','no-store']);
        expect(accepted.body).toEqual(f.state.businessPayload);
        expect(f.business().map(call=>[call.method,call.path])).toEqual([['GET',recovery],['GET',recovery]]);
        expect(f.calls.some(call=>call.path==='/internal/feature-flags/evaluated')).toBe(false);
        expect(f.live.mutation).not.toHaveBeenCalled();
    });

    it.each(['session','access','device'])('does not cache a %s denial or forward private business traffic',async cause=>{
        if(cause==='session')f.state.authStatus=401;
        if(cause==='access')f.state.allowed=false;
        const denied=await f.send(recovery,cause==='device'?{headers:deviceHeaders}:{});
        expect(denied.status).toBe(cause==='session'?401:403);
        expect(denied.headers.get('cache-control')).toBe('no-store');
        expect(f.business()).toEqual([]);expect(f.live.mutation).not.toHaveBeenCalled();
    });

    it.each(['auth','access','catalog'])('keeps the %s failure uncached without a receipt replay',async fault=>{
        if(fault==='auth')f.state.authStatus=503;
        if(fault==='access')f.state.accessStatus=503;
        if(fault==='catalog')f.state.handler=req=>{req.socket.destroy();};
        const failed=await f.send(recovery);
        expect(failed.status).toBe(fault==='catalog'?502:503);
        expect(failed.headers.get('cache-control')).toBe('no-store');
        expect(f.business().map(call=>call.method)).toEqual(fault==='catalog'?['GET']:[]);
        expect(f.live.mutation).not.toHaveBeenCalled();
    });

    it('preserves the service owner denial after a session switch instead of serving the previous receipt',async()=>{
        f.state.handler=(_req,res,call)=>{
            const actor=JSON.parse(decodeURIComponent(String(call.headers['x-bridge-actor'])));
            reply(res,actor.email==='owner@example.test'?200:404,actor.email==='owner@example.test'?{id:jobId,private:'own answer'}:{message:'Not found'});
        };
        const own=await f.send(recovery);f.state.authEmail='other@example.test';
        const foreign=await f.send(recovery);
        expect(own.status).toBe(200);expect(foreign.status).toBe(404);
        expect([own.headers.get('cache-control'),foreign.headers.get('cache-control')]).toEqual(['no-store','no-store']);
        expect(foreign.body).toEqual({message:'Not found'});
        expect(f.business().map(call=>call.method)).toEqual(['GET','GET']);
    });

    it('keeps the cache policy scoped to the private route namespace',async()=>{
        const publicResult=await f.send('/api/projects');
        expect(publicResult.status).toBe(200);expect(publicResult.headers.get('cache-control')).toBeNull();
        f.state.allowed=false;
        const unrelated=await f.send('/api/system-role-chats-static');
        expect(unrelated.status).toBe(403);expect(unrelated.headers.get('cache-control')).toBeNull();
        expect(f.business().map(call=>call.path)).toEqual(['/api/projects']);
    });
});
