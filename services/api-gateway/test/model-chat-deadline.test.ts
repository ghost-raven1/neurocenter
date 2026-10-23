import axios from 'axios';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import type {Request,Response} from 'express';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {forwardModelInference} from '../src/proxy/model-inference-forward';
import {MODEL_CHAT_ROUND_TIMEOUT_MS,MODEL_CHAT_GATEWAY_TIMEOUT_MS,MODEL_CHAT_EDGE_TIMEOUT_MS,MODEL_CHAT_CLIENT_TIMEOUT_MS} from '../../shared/model-chat-deadline.cjs';

const id='11111111-1111-4111-8111-111111111111';
afterEach(()=>vi.useRealTimers());

describe('Chat deadline across actual Gateway HTTP transport and edge configuration',()=>{
    it('leaves response time between the round, Gateway, edge and browser budgets',()=>{
        expect(MODEL_CHAT_GATEWAY_TIMEOUT_MS).toBeGreaterThan(MODEL_CHAT_ROUND_TIMEOUT_MS);
        expect(MODEL_CHAT_EDGE_TIMEOUT_MS).toBeGreaterThan(MODEL_CHAT_GATEWAY_TIMEOUT_MS);
        expect(MODEL_CHAT_CLIENT_TIMEOUT_MS).toBeGreaterThan(MODEL_CHAT_EDGE_TIMEOUT_MS);
    });
    it.each(['turns',`turns/${id}/retry`])('keeps a permitted 650-second %s round connected',async suffix=>{
        const result=await request(`/api/model-chats/${id}/${suffix}`,650000);
        expect(result.error).toBeUndefined();expect(result.response?.data).toEqual({answer:'finished within the round budget'});
    });
    it('still bounds direct provider requests before the saved-chat round limit',async()=>{
        const result=await request('/api/models/model-fixture/ollama/api/chat',650000);
        expect(result.error?.code).toBe('ECONNABORTED');expect(result.response).toBeUndefined();
    });
    it.each(['nginx.conf','nginx.production.conf.template'])('keeps %s turn/retry routes beyond the Gateway deadline',async file=>{
        const config=await readFile(new URL('../../../frontend/'+file,import.meta.url),'utf8');
        const blocks=[...config.matchAll(/location\s+~\s+(\S+)\s*\{([^}]+)\}/g)];
        const expression=(pattern:string)=>new RegExp(pattern.startsWith('"')?JSON.parse(pattern):pattern);
        const turns=blocks.find(([,pattern])=>expression(pattern).test(`/api/model-chats/${id}/turns`));
        expect(turns,'a dedicated long-round route must precede the generic API timeout').toBeDefined();
        const match=turns!;
        expect(expression(match[1]).test(`/api/model-chats/${id}/turns/${id}/retry`)).toBe(true);
        expect(expression(match[1]).test('/api/models/model-fixture/ollama/api/chat')).toBe(false);
        const timeout=Number(/proxy_read_timeout\s+(\d+)s/.exec(match[2])?.[1])*1000;
        expect(timeout).toBe(MODEL_CHAT_EDGE_TIMEOUT_MS);expect(timeout).toBeGreaterThan(MODEL_CHAT_GATEWAY_TIMEOUT_MS);
    });
});

/** Real Axios + loopback HTTP; only its JS deadline advances, without waiting fifteen minutes. */
async function request(route:string,elapsed:number){
    let respond!:http.ServerResponse,received!:()=>void;
    const accepted=new Promise<void>(resolve=>{received=resolve;}),server=http.createServer((_req,res)=>{respond=res;received();});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address() as {port:number};
    const req=Object.assign(new EventEmitter(),{path:route,aborted:false}) as unknown as Request;
    const res=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false}) as unknown as Response;
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const pending=forwardModelInference(axios.create({proxy:false}),{url:`http://127.0.0.1:${address.port}/round`,method:'POST',data:{}},req,res)
        .then(response=>({response,error:undefined as {code?:string}|undefined}),error=>({response:undefined,error:error as {code?:string}}));
    try{
        await accepted;await vi.advanceTimersByTimeAsync(elapsed);
        if(!respond.destroyed)respond.end(JSON.stringify({answer:'finished within the round budget'}));
        return await pending;
    }finally{
        res.emit('close');vi.useRealTimers();server.closeAllConnections();
        await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
}
