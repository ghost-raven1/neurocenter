import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createServer as createHttpServer,get,Agent,type Server} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer,type ViteDevServer} from 'vite';
import viteConfig from '../vite.config';

const payload=Buffer.from(Array.from({length:512*1024},(_,index)=>index%251));
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const agent=new Agent({keepAlive:true});
let upstream:Server,vite:ViteDevServer,root:string,base:string;

/** A hard client deadline makes a stuck proxy an explicit failure instead of a hanging suite. */
function download(route:string):Promise<{state:string;bytes:number;sha256:string;status?:number;elapsed:number}>{
    return new Promise(resolve=>{
        let settled=false,bytes=0,status:number|undefined;
        const hash=createHash('sha256'),started=Date.now();
        const finish=(state:string)=>{
            if(settled)return;settled=true;clearTimeout(deadline);
            resolve({state,bytes,sha256:hash.digest('hex'),status,elapsed:Date.now()-started});
        };
        const request=get(base+route,{agent},response=>{
            status=response.statusCode;
            response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;hash.update(chunk);});
            response.once('end',()=>finish('end'));
            response.once('aborted',()=>finish('aborted'));
            response.once('close',()=>{if(!response.complete)finish('close');});
            response.on('error',()=>finish('response-error'));
        });
        const deadline=setTimeout(()=>{finish('timeout');request.destroy();},1500);
        request.on('error',()=>finish('request-error'));
    });
}

beforeAll(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-vite-proxy-'));
    await fs.writeFile(path.join(root,'index.html'),'<!doctype html><title>Isolated proxy fixture</title>');
    upstream=createHttpServer((request,response)=>{
        response.writeHead(200,{'content-type':'application/octet-stream','content-length':payload.length});
        if(request.url?.endsWith('/partial')){
            response.write(payload.subarray(0,128*1024),()=>{setTimeout(()=>response.destroy(),10);});
        }else response.end(payload);
    });
    upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
    const target='http://127.0.0.1:'+(upstream.address() as {port:number}).port;
    vi.stubEnv('VITE_API_PROXY_TARGET',target);vi.stubEnv('VITE_AUTH_PROXY_TARGET',target);
    const config=await viteConfig({command:'serve',mode:'test',isSsrBuild:false,isPreview:false});
    expect((config.server!.proxy!['/socket.io'] as {ws:boolean}).ws).toBe(true);
    const portLease=createHttpServer();portLease.listen(0,'127.0.0.1');await once(portLease,'listening');
    const vitePort=(portLease.address() as {port:number}).port;
    await new Promise<void>(resolve=>portLease.close(()=>resolve()));
    vite=await createServer({...config,configFile:false,root,mode:'test',logLevel:'silent',
        optimizeDeps:{noDiscovery:true,include:[]},server:{...config.server,host:'127.0.0.1',port:vitePort,strictPort:true,watch:null,hmr:false}});
    await vite.listen();base='http://127.0.0.1:'+(vite.httpServer!.address() as {port:number}).port;
});
afterAll(async()=>{
    agent.destroy();await vite?.close();
    if(upstream){upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
    if(root)await fs.rm(root,{recursive:true,force:true});vi.unstubAllEnvs();
});

describe('Actual Vite dev proxy streams on isolated ephemeral HTTP servers',()=>{
    it.each(['/api','/auth','/socket.io'])('Forwards all512KiB and exact SHA through %s',async prefix=>{
        const result=await download(prefix+'/success');
        expect(result).toMatchObject({state:'end',status:200,bytes:payload.length,sha256:digest(payload)});
    });
    it('Closes a partial upstream abort before the client deadline and serves the next GET',async()=>{
        const result=await download('/api/partial');
        expect(result.state).toMatch(/^(aborted|close|response-error)$/);
        expect(result.status).toBe(200);expect(result.bytes).toBeGreaterThan(0);expect(result.bytes).toBeLessThan(payload.length);
        expect(result.elapsed).toBeLessThan(1500);
        expect(await download('/api/success')).toMatchObject({state:'end',status:200,bytes:payload.length,sha256:digest(payload)});
    });
});
