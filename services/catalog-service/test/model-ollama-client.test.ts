import {describe,it,expect,vi} from 'vitest';
import {OllamaClient,modelRuntimeUrl,type IModelProgress} from '../src/models/ollama-client';
import type {IModel} from '../src/models/model.types';

const model:IModel={id:'model-fixture',name:'Модель',description:'',runtime:'ollama',model:'fixture:1',capability:'embedding',dimension:2,
    manifestSha256:'a'.repeat(64),source:'builtin',revision:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};
const entry={name:model.model,digest:model.manifestSha256};
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
        if(path==='/api/embed')return json({model:model.model,embeddings:[[1,2],[3,4]]});
        throw new Error('Неожиданный endpoint '+path);
    });
    const statfs=vi.fn(async()=>({bavail:64n*1024n**3n,bsize:1n}));
    return {client:new OllamaClient({fetch:fetch as typeof globalThis.fetch,env:{NODE_ENV:'test'},statfs}),fetch,calls,statfs};
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
        expect(calls.map(call=>call.path)).toEqual(['/api/tags','/api/tags','/api/show','/api/embed']);
        expect(calls.at(-1)?.body).toMatchObject({model:model.model,input:expect.any(Array),truncate:false});
        expect(progress.at(-1)?.progress).toBe(100);
    });
    it.each([[[0,0],[3,4]],[[1,2],[3]],[[1,2],[1e100,3]],[[1,2],['private',4]],[[1,2]]].map(vectors=>({vectors})))('отклоняет неправильные векторы $vectors',async({vectors})=>{
        const {client}=fixture({'/api/embed':()=>json({model:model.model,embeddings:vectors})});
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
            '/api/chat':()=>json({model:model.model,done:true,done_reason:'stop',message:{content:'{"number":"42","color":"red"}'}})});
        await context.client.check(vision);
        const body=context.calls.at(-1)!.body!;
        expect(body.stream).toBe(false);expect(JSON.stringify(body)).not.toContain('file://');
        const messages=body.messages as Array<{images:string[]}>;
        expect(Buffer.from(messages[0].images[0],'base64').subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
        const wrong=fixture({'/api/show':()=>json({capabilities:['vision']}),
            '/api/chat':()=>json({model:model.model,done:true,done_reason:'stop',message:{content:'{"number":"41","color":"blue"}'}})});
        await expect(wrong.client.check(vision)).rejects.toThrow(/неверно распознала/);
    });
    it('chat требует непустой завершённый ответ',async()=>{
        const chat={...model,capability:'chat' as const,dimension:null,source:'custom' as const,manifestSha256:null};
        const good=fixture({'/api/show':()=>json({capabilities:['completion']}),
            '/api/chat':()=>json({model:model.model,done:true,done_reason:'stop',message:{content:'OK'}})});
        await good.client.check(chat);
        const bad=fixture({'/api/show':()=>json({capabilities:['completion']}),
            '/api/chat':()=>json({model:model.model,done:false,message:{content:'OK'}})});
        await expect(bad.client.check(chat)).rejects.toThrow(/завершённый/);
    });
    it('stop выгружает только выбранную модель и не удаляет файлы или другие модели',async()=>{
        const {client,calls}=fixture({'/api/chat':()=>json({model:model.model,done:true,done_reason:'unload'})});
        await client.stop(model);
        expect(calls.map(call=>call.path)).toEqual(['/api/tags','/api/chat','/api/ps']);
        expect(calls[1].body).toEqual({model:model.model,messages:[],stream:false,keep_alive:0});
    });
    it('не объявляет stop успешным, когда модель остаётся в памяти',async()=>{
        const {client}=fixture({'/api/chat':()=>json({model:model.model,done:true,done_reason:'unload'}),'/api/ps':()=>json({models:[entry]})});
        await expect(client.stop(model)).rejects.toThrow(/ещё находится в памяти/);
    });
    it('inference закрепляет модель и не разрешает streaming из пользовательского тела',async()=>{
        const context=fixture();
        await context.client.infer(model,'embed',{model:'other:1',stream:true,input:['a','b']});
        expect(context.calls.at(-1)?.body).toMatchObject({model:model.model,stream:false,keep_alive:'5m'});
    });
    it('inference не возвращает частичные или неподходящие векторы',async()=>{
        const context=fixture({'/api/embed':()=>json({model:model.model,embeddings:[[1,2]]})});
        await expect(context.client.infer(model,'embed',{input:['a','b']})).rejects.toThrow(/некорректные векторы/);
    });
});

describe('Поток подготовки весов',()=>{
    function pulling(body:string,installedAfter=true,env:NodeJS.ProcessEnv={}) {
        let reads=0;const context=fixture({'/api/tags':()=>json({models:reads++&&installedAfter?[entry]:[]}),'/api/pull':()=>new Response(body)});
        const client=new OllamaClient({fetch:context.fetch as typeof globalThis.fetch,env:{NODE_ENV:'test',...env},statfs:context.statfs});
        return {...context,client};
    }
    it('полный NDJSON заканчивается SHA и содержательной пробой',async()=>{
        const context=pulling(JSON.stringify({status:'pulling',digest:'sha256:'+'b'.repeat(64),total:100,completed:100})+'\n{"status":"success"}\n');
        const progress:IModelProgress[]=[];await context.client.start(model,value=>{progress.push(value);});
        expect(context.calls.map(call=>call.path)).toEqual(['/api/tags','/api/pull','/api/tags','/api/show','/api/embed']);
        expect(progress.some(value=>value.stage==='downloading'&&value.progress===85)).toBe(true);
    });
    it.each(['{"status":"pulling"}\n','{"error":"PRIVATE"}\n','not JSON\n',JSON.stringify({status:'x'.repeat(65537)})])('отклоняет незавершённый или неверный поток %s',async body=>{
        const context=pulling(body);await expect(context.client.start(model)).rejects.toThrow();
        expect(context.calls.some(call=>call.path==='/api/embed')).toBe(false);
    });
    it('после success не доверяет подменённой версии',async()=>{
        const context=pulling('{"status":"success"}\n',false);
        await expect(context.client.start(model)).rejects.toThrow(/Веса модели не подготовлены/);
    });
    it('большой заявленный layer прерывается до содержательной пробы',async()=>{
        const body=JSON.stringify({status:'pulling',digest:'sha256:'+'b'.repeat(64),total:2*1024**3,completed:0})+'\n{"status":"success"}\n';
        const context=pulling(body,true,{MODEL_DOWNLOAD_MAX_BYTES:String(1024**3)});
        await expect(context.client.start(model)).rejects.toThrow(/лимит загрузки/);
        expect(context.calls.some(call=>call.path==='/api/show')).toBe(false);
    });
    it('недостаток места отклоняет новую загрузку до /api/pull',async()=>{
        const context=pulling('{"status":"success"}\n');
        context.statfs.mockResolvedValue({bavail:1024n**3n,bsize:1n});
        await expect(context.client.start(model)).rejects.toThrow(/Недостаточно свободного места/);
        expect(context.calls.map(call=>call.path)).toEqual(['/api/tags']);
    });
    it('уже сохранённая модель стартует без резерва под повторную загрузку',async()=>{
        const context=fixture();context.statfs.mockResolvedValue({bavail:0n,bsize:1n});
        await context.client.start(model);expect(context.statfs).not.toHaveBeenCalled();
    });
    it('падение места во время потока прерывает подготовку до проверки',async()=>{
        const context=pulling('{"status":"pulling"}\n{"status":"success"}\n');
        context.statfs.mockResolvedValueOnce({bavail:64n*1024n**3n,bsize:1n}).mockResolvedValue({bavail:512n*1024n**2n,bsize:1n});
        await expect(context.client.start(model)).rejects.toThrow(/Недостаточно свободного места/);
        expect(context.calls.some(call=>call.path==='/api/show')).toBe(false);
    });
    it('передаёт внешний abort вместе с собственным deadline',async()=>{
        const controller=new AbortController();const context=fixture();
        await context.client.check(model,controller.signal);
        expect(context.calls[0].signal?.aborted).toBe(false);controller.abort();
        expect(context.calls.every(call=>call.signal?.aborted)).toBe(true);
    });
});
