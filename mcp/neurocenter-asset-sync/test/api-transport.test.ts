import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {api} from '../src/bridge/state.js';
import {errMsg} from '../src/lib/stdio.js';

describe('API transport diagnostics without private upstream details',()=>{
    let directory:string;
    const servers:Array<http.Server|net.Server>=[];
    beforeEach(async()=>{
        directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-api-transport-'));
        vi.stubEnv('NEUROCENTER_BRIDGE_HOME',directory);
        vi.stubEnv('NEUROCENTER_URL','http://site.invalid');
    });
    afterEach(async()=>{
        vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();
        for(const server of servers.splice(0)){if('closeAllConnections'in server)server.closeAllConnections();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
        await fs.rm(directory,{recursive:true,force:true});
    });
    async function listen(server:http.Server|net.Server){
        servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
        const address=server.address();if(!address||typeof address==='string')throw Error('Own TCP fixture did not listen.');
        const origin='http://127.0.0.1:'+address.port;vi.stubEnv('NEUROCENTER_API_URL',origin);return origin;
    }
    async function rejected(){try{await api('worker/pause');throw Error('Expected API transport refusal.');}catch(error){return error as Error&{cause?:{cause?:{code?:string}};status?:number};}}

    it('a real refused connection exposes its API origin and errno through the CLI message',async()=>{
        const server=net.createServer(),origin=await listen(server);
        await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
        const error=await rejected();
        expect(errMsg(error)).toContain(origin);expect(errMsg(error)).toContain('ECONNREFUSED');
        expect(error.cause).toBeInstanceOf(TypeError);expect(error.cause?.cause?.code).toBe('ECONNREFUSED');
        expect(error.message).not.toContain('/api/device-channel/');expect(error.status).toBeUndefined();
    });

    it.each([401,403,503])('a real HTTP %s keeps its existing status and server message',async status=>{
        await listen(http.createServer((request,response)=>{request.resume();response.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify({message:'Исходный отказ API'}));}));
        const error=await rejected();expect(error.message).toBe('Исходный отказ API');expect(error.status).toBe(status);expect(error.cause).toBeUndefined();
    });

    it('a real successful POST keeps its request and parsed response contract',async()=>{
        let requestBody='',method='',route='';
        await listen(http.createServer((request,response)=>{method=request.method!;route=request.url!;request.on('data',chunk=>{requestBody+=chunk;});request.on('end',()=>response.writeHead(200,{'content-type':'application/json'}).end('{"activeJobs":0}'));}));
        expect(await api('worker/pause',{fixture:true})).toEqual({activeJobs:0});
        expect({method,route,requestBody}).toEqual({method:'POST',route:'/api/device-channel/worker/pause',requestBody:'{"fixture":true}'});
    });

    it('a real malformed response remains a JSON error rather than a transport diagnostic',async()=>{
        await listen(http.createServer((request,response)=>{request.resume();response.end('not JSON');}));
        await expect(api('worker/pause')).rejects.toBeInstanceOf(SyntaxError);
    });

    it('invalid API configuration fails before fetch without being relabelled as a network error',async()=>{
        vi.stubEnv('NEUROCENTER_API_URL','https://example.test/private?token=private-query');
        const request=vi.fn();vi.stubGlobal('fetch',request);
        await expect(api('worker/pause')).rejects.toThrow('Адрес API Gateway должен быть HTTP(S) origin без ключей и параметров.');
        expect(request).not.toHaveBeenCalled();
    });

    it('a cyclic input stays a local serialization failure and never reaches fetch',async()=>{
        vi.stubEnv('NEUROCENTER_API_URL','https://example.test');
        const request=vi.fn(),input:{self?:unknown}={};input.self=input;vi.stubGlobal('fetch',request);
        const error=await api('worker/pause',input).catch(error=>error);
        expect(error).toBeInstanceOf(TypeError);expect((error as Error).message).not.toContain('Не удалось связаться');expect((error as Error).cause).toBeUndefined();expect(request).not.toHaveBeenCalled();
    });

    it.each(['DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','ENOTFOUND'])('reports safe cause code %s and preserves the original fetch error',async code=>{
        vi.stubEnv('NEUROCENTER_API_URL','');
        vi.stubEnv('NEUROCENTER_URL','https://private-user:private-password@example.test/private?token=private-query');
        const cause=Object.assign(new Error('private cause message https://private-user:private-password@elsewhere.test/?token=private-query'),{code});
        const failure=new TypeError('fetch failed private-outer-message',{cause});vi.stubGlobal('fetch',vi.fn().mockRejectedValue(failure));
        const error=await rejected();expect(error.message).toContain('https://example.test');expect(error.message).toContain(code);expect(error.cause).toBe(failure);
        expect(error.message).not.toMatch(/private|elsewhere|token=|\/api\/device-channel\//);
    });

    it('a timeout uses a safe fixed code while retaining the original abort reason',async()=>{
        vi.stubEnv('NEUROCENTER_API_URL','https://example.test');
        const failure=new DOMException('private timeout reason','TimeoutError');vi.stubGlobal('fetch',vi.fn().mockRejectedValue(failure));
        const error=await rejected();expect(error.message).toContain('TIMEOUT');expect(error.message).not.toContain('private');expect(error.cause).toBe(failure);
    });

    it('a direct known transport errno is retained without its raw message',async()=>{
        vi.stubEnv('NEUROCENTER_API_URL','https://example.test');
        const failure=Object.assign(new Error('private connect reason'),{code:'ETIMEDOUT'});vi.stubGlobal('fetch',vi.fn().mockRejectedValue(failure));
        const error=await rejected();expect(error.message).toContain('ETIMEDOUT');expect(error.message).not.toContain('private');expect(error.cause).toBe(failure);
    });

    it('an unregistered code and raw cause message cannot enter the CLI diagnostic',async()=>{
        vi.stubEnv('NEUROCENTER_API_URL','https://example.test');
        const failure=new TypeError('private outer detail',{cause:Object.assign(new Error('private inner detail'),{code:'PRIVATE_TOKEN=do-not-print'})});vi.stubGlobal('fetch',vi.fn().mockRejectedValue(failure));
        const error=await rejected();expect(error.message).toContain('https://example.test');expect(error.message).not.toMatch(/private|PRIVATE_TOKEN|do-not-print/);expect(error.cause).toBe(failure);
    });

    it('a non-Error rejection is preserved privately without stringifying it into the diagnostic',async()=>{
        vi.stubEnv('NEUROCENTER_API_URL','https://example.test');vi.stubGlobal('fetch',vi.fn().mockRejectedValue('private-token-rejection'));
        const error=await rejected();expect(error.message).toContain('https://example.test');expect(error.message).not.toContain('private-token');expect(error.cause).toBe('private-token-rejection');
    });

    it('a pre-aborted caller never dispatches its read-only request',async()=>{
        vi.stubEnv('NEUROCENTER_API_URL','https://example.test');
        const request=vi.fn(async()=>new Response('{}')),controller=new AbortController();vi.stubGlobal('fetch',request);controller.abort();
        await expect(api('worker/update-cleanup/authorize',{},'owned-override',controller.signal)).rejects.toBe(controller.signal.reason);
        expect(request).not.toHaveBeenCalled();
    });

    it.each([false,true])('caller cancellation interrupts a real pending HTTP response (body=%s)',async body=>{
        let arrived!:()=>void;const ready=new Promise<void>(resolve=>{arrived=resolve;});
        let authorization='';
        await listen(http.createServer((request,response)=>{
            request.resume();authorization=String(request.headers.authorization);
            if(body){response.writeHead(200,{'content-type':'application/json'});response.flushHeaders();response.write('{"ok":');}
            else arrived();
        }));
        if(body){const original=globalThis.fetch;vi.stubGlobal('fetch',async(...args:Parameters<typeof fetch>)=>{const response=await original(...args);arrived();return response;});}
        const timeout=vi.spyOn(AbortSignal,'timeout'),controller=new AbortController();
        let error:unknown;void api('worker/update-cleanup/authorize',{},'owned-override',controller.signal).catch(value=>{error=value;});
        await ready;expect(timeout).toHaveBeenCalledWith(20000);controller.abort();
        await vi.waitFor(()=>expect(error).toBe(controller.signal.reason),{timeout:1000});
        expect(authorization).toBe('Bearer owned-override');
    });
});
