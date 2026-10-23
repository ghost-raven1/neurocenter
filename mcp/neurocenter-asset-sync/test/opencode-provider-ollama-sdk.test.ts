import {describe,expect,it,vi} from 'vitest';
import {createOllama} from '../src/features/opencode-providers/ollama-sdk.js';

const provider='neurocenter-ollama-'+'c'.repeat(16),modelId='qwen3:8b';
const response=(message:Record<string,unknown>,done=true)=>({model:modelId,created_at:'2026-10-24T00:00:00Z',message:{role:'assistant',content:'',...message},done,done_reason:'stop',prompt_eval_count:12,eval_count:3});
const prompt=[{role:'user' as const,content:[{type:'text' as const,text:'Read the project file'}]}];
const options={temperature:0,topP:0.4,maxOutputTokens:128,contextWindow:16384};
describe('Pinned Provider V3 Ollama wire adapter',()=>{
    it('uses native /api/chat with the exact model, optional bearer auth and all declared generation controls',async()=>{
        const calls:Array<{url:string;body:any;headers:Headers}>=[],request=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
            calls.push({url:String(input),body:JSON.parse(String(init?.body)),headers:new Headers(init?.headers)});
            return Response.json(response({content:'Read complete',tool_calls:[{id:'call-1',function:{name:'read_file',arguments:{path:'src/auth.ts'}}}]}));
        });
        const model=createOllama({name:provider,baseURL:'https://ollama.example.test/prefix',apiKey:'PRIVATE_OLLAMA_KEY',fetch:request}).languageModel(modelId);
        const result=await model.doGenerate({prompt,providerOptions:{[provider]:options},tools:[{type:'function',name:'read_file',description:'Read one file',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}}]});
        expect(model.specificationVersion).toBe('v3');expect(calls).toHaveLength(1);expect(calls[0]!.url).toBe('https://ollama.example.test/prefix/api/chat');
        expect(calls[0]!.headers.get('Authorization')).toBe('Bearer PRIVATE_OLLAMA_KEY');
        expect(calls[0]!.body).toMatchObject({model:modelId,stream:false,messages:[{role:'user',content:'Read the project file'}],options:{temperature:0,top_p:0.4,num_predict:128,num_ctx:16384},tools:[{function:{name:'read_file'}}]});
        expect(result.content).toContainEqual({type:'tool-call',toolCallId:'call-1',toolName:'read_file',input:'{"path":"src/auth.ts"}'});
        expect(result.finishReason.unified).toBe('tool-calls');expect(JSON.stringify(result)).not.toContain('PRIVATE_OLLAMA_KEY');
    });
    it('streams text and tool calls over the same native endpoint without an invented key',async()=>{
        let sent:RequestInit|undefined;
        const model=createOllama({name:provider,baseURL:'http://127.0.0.1:11434',fetch:async(_input,init)=>{
            sent=init;return new Response([response({content:'OK'},false),response({tool_calls:[{id:'stream-call',function:{name:'read_file',arguments:{path:'a.ts'}}}]})].map(value=>JSON.stringify(value)).join('\n')+'\n',{headers:{'Content-Type':'application/x-ndjson'}});
        }}).languageModel(modelId);
        const result=await model.doStream({prompt,providerOptions:{[provider]:options}}),chunks=[];
        for await(const chunk of result.stream)chunks.push(chunk);
        expect(new Headers(sent?.headers).has('Authorization')).toBe(false);expect(JSON.parse(String(sent?.body))).toMatchObject({stream:true,options:{num_ctx:16384,num_predict:128}});
        expect(chunks).toContainEqual(expect.objectContaining({type:'text-delta',delta:'OK'}));expect(chunks).toContainEqual(expect.objectContaining({type:'tool-call',toolName:'read_file'}));expect(chunks.at(-1)).toMatchObject({type:'finish'});
    });
    it('forwards abort to the owned request, rather than retrying or falling back to another model',async()=>{
        const abort=new AbortController(),request=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
            await new Promise<void>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true});});
            return Response.json(response({content:'too late'}));
        });
        const pending=createOllama({name:provider,baseURL:'https://ollama.example.test',fetch:request}).languageModel(modelId).doGenerate({prompt,abortSignal:abort.signal});
        await vi.waitFor(()=>expect(request).toHaveBeenCalledOnce());abort.abort(new Error('OWNED_ABORT'));
        await expect(pending).rejects.toThrow('OWNED_ABORT');expect(request).toHaveBeenCalledOnce();
    });
    it('rejects unknown options rather than silently dropping their values',async()=>{
        const request=vi.fn();await expect(createOllama({name:provider,baseURL:'https://ollama.example.test',fetch:request}).languageModel(modelId)
            .doGenerate({prompt,providerOptions:{[provider]:{unknown:false}}})).rejects.toThrow('Параметры Ollama');expect(request).not.toHaveBeenCalled();
    });
    it('encodes vision file bytes as native base64 rather than serializing a Uint8Array object',async()=>{
        let body:any;const model=createOllama({name:provider,baseURL:'https://ollama.example.test',fetch:async(_url,init)=>{body=JSON.parse(String(init?.body));return Response.json(response({content:'Image read'}));}}).languageModel(modelId);
        await model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'Read this image'},{type:'file',mediaType:'image/png',data:new Uint8Array([1,2,3])}]}]});
        expect(body.messages[0]).toMatchObject({content:'Read this image',images:['AQID']});expect(model.supportedUrls).toEqual({});
    });
    it.each(['image-url','pdf'])('does not silently omit an unsupported %s file part',async kind=>{
        const request=vi.fn(),model=createOllama({name:provider,baseURL:'https://ollama.example.test',fetch:request}).languageModel(modelId);
        await expect(model.doGenerate({prompt:[{role:'user',content:[{type:'file',mediaType:kind==='pdf'?'application/pdf':'image/png',data:kind==='image-url'?new URL('https://private.example.test/image'):new Uint8Array([1,2])}]}]})).rejects.toThrow('файл изображения');expect(request).not.toHaveBeenCalled();
    });
});
