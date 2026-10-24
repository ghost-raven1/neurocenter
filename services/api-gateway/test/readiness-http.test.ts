import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {createServer} from 'node:http';
import {ServiceUnavailableException} from '@nestjs/common';
import {AppController} from '../src/app.controller';

const services={catalog:'CATALOG_SERVICE_URL',skills:'SKILLS_SERVICE_URL',rag:'RAG_SERVICE_URL',auth:'AUTH_SERVICE_URL',featureFlags:'FEATURE_FLAGS_SERVICE_URL'};
let base='',fault:string|undefined,mode='http';const paths:string[]=[];
const server=createServer((req,res)=>{
    paths.push(req.url!);const name=req.url!.split('/')[1];
    if(name!==fault){res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');return;}
    if(mode==='redirect'){res.writeHead(302,{location:base+'/redirect-target'});res.end();return;}
    if(mode==='hang'){res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
    if(mode==='http'){res.writeHead(503);res.end('private dependency failure');return;}
    res.writeHead(200,{'content-type':'application/json'});
    res.end(mode==='false'?'{"ok":false}':mode==='html'?'<html>login</html>':JSON.stringify({ok:true,detail:'x'.repeat(17000)}));
});
beforeAll(async()=>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+(server.address() as {port:number}).port;});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
beforeEach(()=>{paths.length=0;fault=undefined;mode='http';for(const[name,key]of Object.entries(services))vi.stubEnv(key,base+'/'+name);});
afterEach(()=>vi.unstubAllEnvs());

it('reports dependency diagnostics separately from confirmed health of all five actual HTTP dependencies',async()=>{
    const controller=new AppController();expect(controller.health()).toEqual({ok:true});
    expect(await controller.dependencies()).toEqual({ok:true,checks:Object.fromEntries(Object.keys(services).map(name=>[name,'ready']))});
    expect(paths.sort()).toEqual(Object.keys(services).map(name=>'/'+name+'/ready').sort());
});
it.each(Object.keys(services))('rejects dependency diagnostics when %s is unavailable without leaking private detail',async name=>{
    fault=name;const controller=new AppController();let failure:ServiceUnavailableException|undefined;
    try{await controller.dependencies();}catch(error){failure=error as ServiceUnavailableException;}
    expect(failure).toBeInstanceOf(ServiceUnavailableException);expect(failure!.getStatus()).toBe(503);
    expect(failure!.getResponse()).toEqual({ok:false,checks:Object.fromEntries(Object.keys(services).map(key=>[key,key===name?'unavailable':'ready']))});
    expect(JSON.stringify(failure!.getResponse())).not.toMatch(/private|127\.0\.0\.1|https?:/);
    expect(controller.health()).toEqual({ok:true});
});
it.each(['false','html','oversize','redirect','hang'])('requires bounded JSON success, even with HTTP200: %s',async value=>{
    fault='catalog';mode=value;const start=performance.now();
    await expect(new AppController().dependencies()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(paths).not.toContain('/redirect-target');expect(performance.now()-start).toBeLessThan(4000);
});
it('uses the documented local endpoints when no explicit upstream is configured',async()=>{
    for(const key of Object.values(services))vi.stubEnv(key,'');
    const request=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>Response.json({ok:true}));vi.stubGlobal('fetch',request);
    try{await new AppController().dependencies();expect(request.mock.calls.map(call=>String(call[0])).sort()).toEqual([4100,4200,4300,22222,4400].map(port=>'http://localhost:'+port+'/ready').sort());}
    finally{vi.unstubAllGlobals();}
});
