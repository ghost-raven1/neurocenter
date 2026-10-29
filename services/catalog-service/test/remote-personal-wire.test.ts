import {describe,expect,it,vi} from 'vitest';
import {RemoteModelClient} from '../src/models/remote-model-client';
import {withModelUsage} from '../src/model-usage/model-usage.context';
import type {IModel} from '../src/models/model.types';

const model={id:'remote-one',name:'Remote',description:'',runtime:'remote-openai',model:'fixture',modelVersion:'1',capability:'chat',source:'custom',dimension:null,revision:1,manifestSha256:null,createdAt:'',updatedAt:''} as IModel;
const response=()=>new Response(JSON.stringify({model:'fixture',choices:[{index:0,finish_reason:'stop',message:{content:'OK'}}],usage:{prompt_tokens:1,completion_tokens:1}}),{headers:{'content-type':'application/json'}});
describe('personal credential is captured at the literal fetch boundary',()=>{
    it('uses the current actor key and starts releasing the lease before awaiting provider response',async()=>{
        const events:string[]=[],release=vi.fn(async()=>{events.push('release');}),acquire=vi.fn(async()=>({apiKey:'personal-alice',release}));
        let observed:string|undefined;
        const fetch=vi.fn(async(_url:unknown,request?:RequestInit)=>{events.push('fetch');observed=(request?.headers as Record<string,string>).authorization;return response();});
        const client=new RemoteModelClient({fetch:fetch as typeof globalThis.fetch});
        await withModelUsage({purpose:'chat',actorEmail:'alice@test',actorRole:'Разработчик',providerWire:{acquire}},()=>client.infer(model,{modelId:model.id,revision:1,baseUrl:'https://provider.test/v1',requestDimensions:false,apiKey:'LEGACY_SHARED_MUST_NOT_SEND'},'chat',{messages:[{role:'user',content:'hello'}]}));
        expect(observed).toBe('Bearer personal-alice');expect(acquire).toHaveBeenCalledOnce();expect(events).toEqual(['fetch','release']);expect(release).toHaveBeenCalledOnce();
    });
    it.each([undefined,'personal-bob'])('none/optional never falls back to a shared key (%s)',async current=>{
        let observed:string|undefined;
        const client=new RemoteModelClient({fetch:vi.fn(async(_url,request)=>{observed=(request?.headers as Record<string,string>).authorization;return response();}) as typeof fetch});
        await withModelUsage({purpose:'chat',actorEmail:'bob@test',actorRole:'Разработчик',providerWire:{acquire:async()=>({apiKey:current,release:async()=>undefined})}},
            ()=>client.infer(model,{modelId:model.id,revision:1,baseUrl:'https://provider.test/v1',requestDimensions:false,apiKey:'GLOBAL_FORBIDDEN'},'chat',{messages:[{role:'user',content:'hello'}]}));
        expect(observed).toBe(current?'Bearer '+current:undefined);
    });
    it('required setup rejection performs no fetch and never falls back to legacy/environment credentials',async()=>{
        const fetch=vi.fn();const client=new RemoteModelClient({fetch});
        await expect(withModelUsage({purpose:'chat',actorEmail:'bob@test',actorRole:'Разработчик',providerWire:{acquire:async()=>{throw Error('Настройте Мой доступ');}}},
            ()=>client.infer(model,{modelId:model.id,revision:1,baseUrl:'https://provider.test/v1',requestDimensions:false,apiKey:'GLOBAL'},'chat',{messages:[{role:'user',content:'hello'}]}))).rejects.toThrow('Мой доступ');
        expect(fetch).not.toHaveBeenCalled();
    });
    it('a held HTTP response does not hold the SQL lease; redirect policy stays error',async()=>{
        let finish!:(value:Response)=>void;const responsePromise=new Promise<Response>(resolve=>{finish=resolve;});const release=vi.fn(async()=>undefined);
        const fetch=vi.fn((_url:unknown,request?:RequestInit)=>{expect(request?.redirect).toBe('error');return responsePromise;});
        const client=new RemoteModelClient({fetch:fetch as typeof globalThis.fetch});
        const pending=withModelUsage({purpose:'chat',actorEmail:'alice@test',actorRole:'Разработчик',providerWire:{acquire:async()=>({apiKey:'alice',release})}},()=>
            client.infer(model,{modelId:model.id,revision:1,baseUrl:'https://provider.test/v1',requestDimensions:false},'chat',{messages:[{role:'user',content:'hello'}]}));
        await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());expect(release).toHaveBeenCalledOnce();finish(response());await pending;
    });
});
