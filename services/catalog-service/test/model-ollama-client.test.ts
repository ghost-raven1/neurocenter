vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import {describe,it,expect,vi} from 'vitest';
import {OllamaClient,modelRuntimeUrl,type IModelProgress} from '../src/models/ollama-client';
import {localModelAlias} from '../src/models/local-model-alias';
import type {IModel} from '../src/models/model.types';

const model:IModel={id:'model-fixture',name:'Модель',description:'',runtime:'ollama',model:'fixture:1',capability:'embedding',dimension:2,
    manifestSha256:'a'.repeat(64),source:'builtin',revision:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};
const alias=localModelAlias(model);
const entry={name:alias,digest:model.manifestSha256};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

function fixture(replies:Record<string,()=>Response|Promise<Response>>={}) {
    const calls:Array<{path:string;body:Record<string,unknown>|null;signal?:AbortSignal|null}>=[];
    const fetch=vi.fn(async(url:string|URL|Request,input?:RequestInit)=>{
        const path=new URL(String(url)).pathname;
        expect(input?.redirect).toBe('error');
        calls.push({path,body:input?.body?JSON.parse(String(input.body)):null,signal:input?.signal});
        if(replies[path])return replies[path]();
        if(path==='/api/tags')return json({models:[entry]});
        if(path==='/api/ps')return json({models:[]});
        if(path==='/api/show')return json({capabilities:['embedding']});
        if(path==='/api/embed')return json({model:alias,embeddings:[[1,2],[3,4]]});
        throw new Error('Неожиданный endpoint '+path);
    });
    return {client:new OllamaClient({fetch:fetch as typeof globalThis.fetch,env:{NODE_ENV:'test'}}),fetch,calls};
}

describe('Адрес управляемого runtime',()=>{
    it('принимает loopback в dev и единственный внутренний сервис в production',()=>{
        expect(modelRuntimeUrl({})).toBe('http://127.0.0.1:11435');
        expect(modelRuntimeUrl({MODEL_RUNTIME_URL:'http://localhost:11436'})).toBe('http://localhost:11436');
        expect(modelRuntimeUrl({NODE_ENV:'production',MODEL_RUNTIME_URL:'http://model-runtime:11434'})).toBe('http://model-runtime:11434');
    });
    it('не допускает произвольный сервер, credentials, пути и неявный production URL',()=>{
        for(const url of ['http://example.org:11434','http://169.254.169.254','http://user:secret@localhost:11435','http://localhost:11435/api',
            'https://localhost:11435','http://localhost:11435?private=1','http://localhost:11435/#token'])expect(()=>modelRuntimeUrl({MODEL_RUNTIME_URL:url})).toThrow();
        expect(()=>modelRuntimeUrl({NODE_ENV:'production'})).toThrow(/production/);
        expect(()=>modelRuntimeUrl({NODE_ENV:'production',MODEL_RUNTIME_URL:'http://localhost:11435'})).toThrow();
    });
});

describe('Проверка и хостинг модели',()=>{
    it('различает отсутствие весов, остановленную и загруженную модель без inference',async()=>{
        const missing=fixture({'/api/tags':()=>json({models:[]})});
        expect((await missing.client.status(model)).state).toBe('missing');
        const stopped=fixture();expect((await stopped.client.status(model)).state).toBe('stopped');
        const running=fixture({'/api/ps':()=>json({models:[entry]})});
        expect(await running.client.status(model)).toEqual({state:'ready',message:'Модель загружена в память.',checkedAt:null});
        expect(running.calls.map(call=>call.path)).toEqual(['/api/tags','/api/ps']);
    });
    it('ошибку SHA не выдаёт за готовность и не заменяет существующие веса',async()=>{
        const context=fixture({'/api/tags':()=>json({models:[{...entry,digest:'b'.repeat(64)}]})});
        expect((await context.client.status(model)).state).toBe('error');
        await expect(context.client.start(model)).rejects.toThrow(/SHA/);
        expect(context.calls.every(call=>call.path==='/api/tags')).toBe(true);
    });
    it('недоступный или некорректный runtime даёт понятное состояние без upstream секретов',async()=>{
        const context=fixture({'/api/tags':()=>{throw new Error('token=PRIVATE');}});
        const status=await context.client.status(model);
        expect(status.state).toBe('unavailable');expect(status.message).not.toContain('PRIVATE');
        await expect(context.client.start(model)).rejects.toThrow(/Хостинг моделей недоступен/);
        const malformed=fixture({'/api/tags':()=>json({models:[null]})});
        expect((await malformed.client.status(model)).state).toBe('unavailable');
    });
    it('отключённый хостинг не обращается к сети',async()=>{
        const fetch=vi.fn();const client=new OllamaClient({fetch,env:{MODEL_HOSTING_ENABLED:'false'}});
        expect((await client.status(model)).message).toContain('отключён');
        await expect(client.start(model)).rejects.toThrow(/отключён/);expect(fetch).not.toHaveBeenCalled();
    });
    it('известные веса повторно не скачиваются, проверка требует реальные векторы',async()=>{
        const {client,calls}=fixture();const progress:IModelProgress[]=[];
        await client.start(model,value=>{progress.push(value);});
        expect(calls.map(call=>call.path)).toEqual(['/api/tags','/api/tags','/api/show','/api/embed','/api/tags']);
        expect(calls.filter(call=>call.path==='/api/embed').pop()?.body).toMatchObject({model:alias,input:expect.any(Array),truncate:false});
        expect(progress.at(-1)?.progress).toBe(100);
    });
    it.each([[[0,0],[3,4]],[[1,2],[3]],[[1,2],[1e100,3]],[[1,2],['private',4]],[[1,2]]].map(vectors=>({vectors})))('отклоняет неправильные векторы $vectors',async({vectors})=>{
        const {client}=fixture({'/api/embed':()=>json({model:alias,embeddings:vectors})});
        await expect(client.check(model)).rejects.toThrow(/векторы/);
    });
    it('отклоняет неподходящую capability до inference и имя другой модели',async()=>{
        const wrongCapability=fixture({'/api/show':()=>json({capabilities:['completion']})});
        await expect(wrongCapability.client.check(model)).rejects.toThrow(/Возможности/);
        expect(wrongCapability.calls.some(call=>call.path==='/api/embed')).toBe(false);
        const wrongName=fixture({'/api/embed':()=>json({model:'other:1',embeddings:[[1,2],[3,4]]})});
        await expect(wrongName.client.check(model)).rejects.toThrow(/векторы/);
    });
    it('ограничивает размер JSON и отклоняет ошибки внутри HTTP 200',async()=>{
        const tooLarge=fixture({'/api/tags':()=>new Response('x'.repeat(1024*1024+1))});
        await expect(tooLarge.client.start(model)).rejects.toThrow(/размер/);
        const error=fixture({'/api/tags':()=>json({error:'secret PRIVATE'})});
        await expect(error.client.start(model)).rejects.toThrow('Runtime не выполнил запрос.');
    });
    it('не использует чужой registry endpoint и неопределённый тег',async()=>{
        const {client,fetch}=fixture();
        for(const name of ['example.org/private:1','127.0.0.1/private:1','fixture','https://private/model:1','fixture:1\n'])await expect(client.start({...model,model:name})).rejects.toThrow(/Некорректная модель/);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('vision проверяет PNG, число и цвет, не только декларацию runtime',async()=>{
        const vision={...model,capability:'vision' as const,dimension:null};
        const context=fixture({'/api/show':()=>json({capabilities:['completion','vision']}),
            '/api/chat':()=>json({model:alias,done:true,done_reason:'stop',message:{content:'{"number":"42","color":"red"}'}})});
        await context.client.check(vision);
        const body=context.calls.filter(call=>call.path==='/api/chat').pop()!.body!;
        expect(body.stream).toBe(false);expect(JSON.stringify(body)).not.toContain('file://');
        const messages=body.messages as Array<{images:string[]}>;
        expect(Buffer.from(messages[0].images[0],'base64').subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
        const wrong=fixture({'/api/show':()=>json({capabilities:['vision']}),
            '/api/chat':()=>json({model:alias,done:true,done_reason:'stop',message:{content:'{"number":"41","color":"blue"}'}})});
        await expect(wrong.client.check(vision)).rejects.toThrow(/неверно распознала/);
    });
    it('chat требует непустой завершённый ответ',async()=>{
        const chat={...model,capability:'chat' as const,dimension:null,source:'custom' as const};
        const good=fixture({'/api/show':()=>json({capabilities:['completion']}),
            '/api/chat':()=>json({model:alias,done:true,done_reason:'stop',message:{content:'OK'}})});
        await good.client.check(chat);
        const bad=fixture({'/api/show':()=>json({capabilities:['completion']}),
            '/api/chat':()=>json({model:alias,done:false,message:{content:'OK'}})});
        await expect(bad.client.check(chat)).rejects.toThrow(/завершённый/);
    });
    it('stop выгружает только выбранную модель и не удаляет файлы или другие модели',async()=>{
        const {client,calls}=fixture({'/api/chat':()=>json({model:alias,done:true,done_reason:'unload'})});
        await client.stop(model);
        expect(calls.map(call=>call.path)).toEqual(['/api/tags','/api/chat','/api/ps']);
        expect(calls[1].body).toEqual({model:alias,messages:[],stream:false,keep_alive:0});
    });
    it('не объявляет stop успешным, когда модель остаётся в памяти',async()=>{
        const {client}=fixture({'/api/chat':()=>json({model:alias,done:true,done_reason:'unload'}),'/api/ps':()=>json({models:[entry]})});
        await expect(client.stop(model)).rejects.toThrow(/ещё находится в памяти/);
    });
    it('inference закрепляет модель и не разрешает streaming из пользовательского тела',async()=>{
        const context=fixture();
        await context.client.infer(model,'embed',{model:'other:1',stream:true,input:['a','b']});
        expect(context.calls.at(-1)?.body).toMatchObject({model:alias,stream:false,keep_alive:'5m'});
    });
    it('inference не возвращает частичные или неподходящие векторы',async()=>{
        const context=fixture({'/api/embed':()=>json({model:alias,embeddings:[[1,2]]})});
        await expect(context.client.infer(model,'embed',{input:['a','b']})).rejects.toThrow(/некорректные векторы/);
    });
    it.each([
        {usage:{},reported:false},
        {usage:{prompt_eval_count:0,eval_count:0},reported:true},
        {usage:{prompt_eval_count:9},reported:true},
        {usage:{prompt_eval_count:'9',eval_count:-1},reported:false},
    ])('inference отличает фактические счётчики токенов от их отсутствия %#',async({usage,reported})=>{
        const context=fixture({'/api/chat':()=>json({model:alias,done:true,done_reason:'stop',message:{content:'OK'},...usage})});
        const result=await context.client.infer({...model,capability:'chat',dimension:null},'chat',{messages:[{role:'user',content:'Привет'}]});
        expect(result).toMatchObject({model:model.model,usage_reported:reported,...usage});
    });
});

describe('Локальный runtime использует только уже установленные ассеты',()=>{
    it('Отсутствующие веса не запускают прямую загрузку из реестра',async()=>{
        const context=fixture({'/api/tags':()=>json({models:[]})});
        await expect(context.client.start(model)).rejects.toThrow(/проверенного ассета/);
        expect(context.calls.map(call=>call.path)).toEqual(['/api/tags']);
    });
    it('Передаёт внешний abort вместе с собственным deadline',async()=>{
        const controller=new AbortController();const context=fixture();await context.client.check(model,controller.signal);
        expect(context.calls[0].signal?.aborted).toBe(false);controller.abort();expect(context.calls.every(call=>call.signal?.aborted)).toBe(true);
    });
});
