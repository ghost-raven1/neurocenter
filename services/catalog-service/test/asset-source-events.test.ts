import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {notifyAssetSourceChange} from '../src/asset-sources/asset-source-events';

beforeEach(()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','owned-event-token');});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});

it('missing internal credentials never send an unauthenticated event',async()=>{
    vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','');const request=vi.fn();vi.stubGlobal('fetch',request);
    await notifyAssetSourceChange();expect(request).not.toHaveBeenCalled();
});
it('an already aborted lifecycle never starts a notification',async()=>{
    const controller=new AbortController();controller.abort();const request=vi.fn();vi.stubGlobal('fetch',request);
    await notifyAssetSourceChange(controller.signal);expect(request).not.toHaveBeenCalled();
});
it.each([{url:'https://gateway.owned.invalid/',body:true},{url:'',body:false}])('notification uses the configured or default route and releases the response: $url',async({url,body})=>{
    vi.stubEnv('API_GATEWAY_URL',url);const cancelled=vi.fn();
    const request=vi.fn(async()=>new Response(body?new ReadableStream({cancel:cancelled}):null,{status:body?503:204}));vi.stubGlobal('fetch',request);
    const controller=new AbortController();await notifyAssetSourceChange(body?controller.signal:undefined);
    expect(request).toHaveBeenCalledExactlyOnceWith((url||'http://localhost:4000').replace(/\/$/,'')+'/internal/events',{
        method:'POST',headers:{'content-type':'application/json','x-neurocenter-internal':'owned-event-token'},body:JSON.stringify({sections:['catalog']}),signal:expect.any(AbortSignal),
    });
    expect(cancelled).toHaveBeenCalledTimes(body?1:0);
});
