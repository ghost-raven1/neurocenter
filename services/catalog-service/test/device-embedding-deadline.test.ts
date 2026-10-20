import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import http,{type ServerResponse} from 'node:http';
import type {Socket} from 'node:net';
import {DeviceEmbeddingService} from '../src/models/device-embedding.service';
import {requireFeatureEnabled} from '../src/features/require-feature-enabled';
import type {Device,DeviceStore} from '../src/devices/device-store';
import type {ProjectEmbeddingService} from '../src/models/project-embedding.service';
import {OllamaClient} from '../src/models/ollama-client';
import type {IConfiguredProjectEmbedding} from '../src/models/project-embedding.types';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeatureEnabled:vi.fn()}));
const projectId='prj-deadline',bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111';
const device={id:'device-deadline',email:'deadline@example.test',role:'Разработчик',report:{bindings:[{projectId,bindingId,instanceId,valid:true}]}} as unknown as Device;
const modelPin='b'.repeat(64),alias=`neurocenter/model-deadline/sha256/${modelPin}`;
const selected:IConfiguredProjectEmbedding={projectId,revision:1,expectedDimension:3,modelPin,profile:{provider:'openai',model:alias,dimension:3},
    model:{id:'model-deadline',name:'Тестовая модель',description:'',capability:'embedding',runtime:'ollama',model:'fixture:1',manifestSha256:modelPin,
        dimension:3,source:'builtin',revision:1,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}};
const input={projectId,bindingId,instanceId,expectedRevision:1,expectedModelPin:modelPin,model:alias,input:['Первый текст','Второй текст']};
const vectors={embeddings:[[1,0,0],[0,1,0]]};
const claim={userRoles:['Разработчик'],projects:[{projectId,role:'Разработчик'}]};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
function observed<T>(promise:Promise<T>){
    const result:{done:boolean;value?:T;error?:unknown}={done:false};
    void promise.then(value=>{result.value=value;result.done=true;},error=>{result.error=error;result.done=true;});return result;
}
async function flush(){for(let index=0;index<24;index++)await Promise.resolve();}
function fixture(runtime?:OllamaClient){
    const owned=vi.fn().mockResolvedValue(device),claims=vi.fn().mockResolvedValue(claim),query=vi.fn().mockResolvedValue({rows:[{id:projectId}]}),
        requireCurrent=vi.fn().mockResolvedValue(selected),infer=vi.fn().mockResolvedValue(vectors);
    const service=new DeviceEmbeddingService({owned,access:{claims},pool:{query}} as unknown as DeviceStore,
        {requireCurrent} as unknown as ProjectEmbeddingService,runtime??{infer} as unknown as OllamaClient);
    return {service,owned,claims,query,requireCurrent,infer};
}
beforeEach(()=>{vi.useFakeTimers();vi.mocked(requireFeatureEnabled).mockReset().mockResolvedValue(undefined);});
afterEach(()=>{vi.useRealTimers();});

describe('Абсолютный бюджет embedding устройства',()=>{
    it('105 секунд отменяют зависший inference; поздние векторы не проходят повторную проверку',async()=>{
        const context=fixture(),pending=deferred<typeof vectors>();context.infer.mockReturnValue(pending.promise);
        const result=observed(context.service.embed(device,input));await flush();expect(context.infer).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(104999);expect(result.done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);expect(result.done).toBe(true);expect(result.error).toMatchObject({status:503});
        expect(context.infer.mock.calls[0][3]).toBeInstanceOf(AbortSignal);expect(context.infer.mock.calls[0][3].aborted).toBe(true);
        pending.resolve(vectors);await flush();expect(context.owned).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['owned','claims','query','requireCurrent'] as const)('Зависшая проверка %s завершается вовремя и не продолжает цепочку после deadline',async stage=>{
        const context=fixture(),pending=deferred<unknown>();context[stage].mockReturnValueOnce(pending.promise);
        const result=observed(context.service.embed(device,input));await flush();
        await vi.advanceTimersByTimeAsync(105000);expect(result.done).toBe(true);expect(result.error).toMatchObject({status:503});
        const counts=[context.owned,context.claims,context.query,context.requireCurrent].map(mock=>mock.mock.calls.length);
        pending.resolve(({owned:device,claims:claim,query:{rows:[{id:projectId}]},requireCurrent:selected})[stage]);await flush();
        expect([context.owned,context.claims,context.query,context.requireCurrent].map(mock=>mock.mock.calls.length)).toEqual(counts);
        expect(context.infer).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    });
    it('Проверка флагов входит в общий бюджет и не запускает поздний inference',async()=>{
        const context=fixture(),pending=deferred<void>();vi.mocked(requireFeatureEnabled).mockReturnValueOnce(pending.promise);
        const result=observed(context.service.embed(device,input));await flush();await vi.advanceTimersByTimeAsync(105000);
        expect(result.done).toBe(true);expect(result.error).toMatchObject({status:503});
        pending.resolve();await flush();expect(context.infer).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    });
    it('Финальная проверка прав делит прежний deadline с inference, без нового отсчёта',async()=>{
        const context=fixture(),inference=deferred<typeof vectors>(),rights=deferred<Device>();
        context.infer.mockReturnValue(inference.promise);context.owned.mockResolvedValueOnce(device).mockReturnValueOnce(rights.promise);
        const result=observed(context.service.embed(device,input));await flush();await vi.advanceTimersByTimeAsync(100000);
        inference.resolve(vectors);await flush();expect(context.owned).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(4999);expect(result.done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);expect(result.done).toBe(true);expect(result.error).toMatchObject({status:503});
        rights.resolve(device);await flush();expect(context.claims).toHaveBeenCalledOnce();expect(result.value).toBeUndefined();expect(vi.getTimerCount()).toBe(0);
    });
    it('Уже закрытый запрос не читает права и не создаёт таймер',async()=>{
        const context=fixture(),abort=new AbortController();abort.abort();
        const result=observed(context.service.embed(device,input,abort.signal));await flush();
        expect(result.done).toBe(true);expect(context.owned).not.toHaveBeenCalled();expect(context.infer).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    });
    it('Отмена во время проверки прав завершает ожидание и не возобновляет запрос после её ответа',async()=>{
        const context=fixture(),rights=deferred<Device>(),abort=new AbortController();context.owned.mockReturnValueOnce(rights.promise);
        const result=observed(context.service.embed(device,input,abort.signal));await flush();abort.abort();await flush();
        expect(result.done).toBe(true);expect(result.error).toBe(abort.signal.reason);expect(vi.getTimerCount()).toBe(0);
        rights.resolve(device);await flush();expect(context.claims).not.toHaveBeenCalled();expect(context.infer).not.toHaveBeenCalled();
    });
    it('Отмена inference закрывает общий сигнал без ожидания неотзывчивого provider',async()=>{
        const context=fixture(),pending=deferred<typeof vectors>(),abort=new AbortController();context.infer.mockReturnValueOnce(pending.promise);
        const result=observed(context.service.embed(device,input,abort.signal));await flush();abort.abort();await flush();
        expect(result.done).toBe(true);expect(result.error).toBe(abort.signal.reason);expect(context.infer.mock.calls[0][3].aborted).toBe(true);
        pending.resolve(vectors);await flush();expect(context.owned).toHaveBeenCalledOnce();expect(context.infer).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    });
    it('Отмена одного запроса не мешает соседнему и не повторяет inference',async()=>{
        const context=fixture(),first=deferred<typeof vectors>(),second=deferred<typeof vectors>(),abort=new AbortController();
        context.infer.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const cancelled=observed(context.service.embed(device,input,abort.signal)),neighbor=observed(context.service.embed(device,input));await flush();
        abort.abort();await flush();expect(cancelled.done).toBe(true);expect(neighbor.done).toBe(false);expect(context.infer.mock.calls[1][3].aborted).toBe(false);
        second.resolve(vectors);await flush();expect(neighbor.value).toMatchObject({model:alias});expect(context.infer).toHaveBeenCalledTimes(2);
        first.resolve(vectors);await flush();expect(vi.getTimerCount()).toBe(0);
    });
    it('Быстрый успешный ответ сохраняет свежую проверку до и после inference и очищает таймер',async()=>{
        const context=fixture();const value=await context.service.embed(device,input);
        expect(value).toMatchObject({model:alias});expect(context.owned).toHaveBeenCalledTimes(2);expect(context.requireCurrent).toHaveBeenCalledTimes(2);
        expect(context.infer).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    });
});

describe('Настоящий HTTP-транспорт embedding устройства',()=>{
    it('Deadline закрывает HTTP runtime; явный повтор и соседний запрос продолжают работать без внутренних повторов',async()=>{
        vi.useRealTimers();vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
        const arrived=Array.from({length:4},()=>deferred<{response:ServerResponse;closed:Promise<void>}>()),sockets=new Set<Socket>();
        let embeddingRequests=0,tagsRequests=0;
        const server=http.createServer(async(req,res)=>{
            for await(const _chunk of req){/* Полностью читается только синтетический body. */}
            if(req.url==='/api/tags'){
                tagsRequests++;res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({models:[{name:selected.model.model,digest:modelPin}]}));return;
            }
            if(req.url!=='/api/embed'){res.writeHead(404).end();return;}
            const close=deferred<void>(),request=arrived[embeddingRequests++];res.once('close',()=>close.resolve());
            request.resolve({response:res,closed:close.promise});
        });
        server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
        await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
        const port=(server.address() as {port:number}).port;
        const runtime=new OllamaClient({fetch:globalThis.fetch,env:{NODE_ENV:'test',MODEL_RUNTIME_URL:`http://127.0.0.1:${port}`}}),context=fixture(runtime);
        const replies:Array<Promise<unknown>>=[];
        const run=(signal?:AbortSignal)=>{const request=context.service.embed(device,input,signal);replies.push(request);return observed(request);};
        const complete=(response:ServerResponse)=>response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({model:selected.model.model,...vectors}));
        try{
            const timedOut=run(),first=await arrived[0].promise;
            await vi.advanceTimersByTimeAsync(105000);expect(timedOut.done).toBe(true);expect(timedOut.error).toMatchObject({status:503});
            await first.closed;expect(first.response.destroyed).toBe(true);expect(embeddingRequests).toBe(1);expect(context.owned).toHaveBeenCalledOnce();
            const retry=run(),second=await arrived[1].promise;complete(second.response);await Promise.allSettled(replies);await flush();
            expect(retry.value).toMatchObject({model:alias});expect(embeddingRequests).toBe(2);
            const abort=new AbortController(),cancelled=run(abort.signal),third=await arrived[2].promise;
            const neighbor=run(),fourth=await arrived[3].promise;abort.abort();await third.closed;await flush();
            expect(cancelled.done).toBe(true);expect(cancelled.error).toBe(abort.signal.reason);expect(fourth.response.destroyed).toBe(false);
            complete(fourth.response);await Promise.allSettled(replies);await flush();
            expect(neighbor.value).toMatchObject({model:alias});expect(embeddingRequests).toBe(4);expect(tagsRequests).toBe(4);
        }finally{
            const closed=[...sockets].map(socket=>new Promise<void>(resolve=>socket.once('close',()=>resolve())));
            server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
            await Promise.allSettled(replies);await Promise.all(closed);
        }
        expect(server.listening).toBe(false);expect(sockets.size).toBe(0);
    });
});
