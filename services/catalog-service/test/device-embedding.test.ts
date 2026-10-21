import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Device,DeviceStore} from '../src/devices/device-store';
import {DeviceEmbeddingService} from '../src/models/device-embedding.service';
import type {HostedRagGrantService} from '../src/models/hosted-rag-grant.service';
import type {OllamaClient} from '../src/models/ollama-client';
import {deviceEmbeddingInput,projectEmbeddingUpdate} from '../src/models/project-embedding.validation';

const email='developer@example.test',projectId='prj-fixture',bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111';
const device={id:'device',email,role:'Разработчик',report:{bindings:[{projectId,bindingId,instanceId,valid:true}]}} as unknown as Device;
const pin='b'.repeat(64),alias=`neurocenter/model-fixture/sha256/${pin}`;
const configured={projectId,revision:1,expectedDimension:3,model:{id:'model-fixture',model:'fixture:1',dimension:3},modelPin:pin,
    profile:{provider:'openai',model:alias,dimension:3}};
const context={projectId,bindingId,instanceId,expectedRevision:1,expectedModelPin:pin,installation:{kind:'mcp' as const,id:'rag-fixture',version:1,manifest:'c'.repeat(64)}};
const input={...context,model:alias,input:['Первый текст','Второй текст']};
const owned=vi.fn(),claims=vi.fn(),query=vi.fn(),requireGrant=vi.fn(),infer=vi.fn();
const service=new DeviceEmbeddingService({owned,access:{claims},pool:{query}} as unknown as DeviceStore,
    {infer} as unknown as OllamaClient,{require:requireGrant} as unknown as HostedRagGrantService);
beforeEach(()=>{
    vi.resetAllMocks();owned.mockResolvedValue(device);claims.mockResolvedValue({email,userRoles:['Разработчик'],projects:[{projectId,projectName:'Проект',role:'Разработчик'}]});
    query.mockResolvedValue({rows:[{id:projectId}]});requireGrant.mockResolvedValue(configured);
    infer.mockResolvedValue({embeddings:[[1,0,0],[0,1,0]],prompt_eval_count:4});
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json(evaluateFeatureFlags(defaultFeatureFlags()))));
});
afterEach(()=>vi.unstubAllGlobals());
describe('Embedding-брокер подключённого устройства',()=>{
    it('Контекст читает свежую привязку и выбор, не вызывает inference или флаги',async()=>{
        expect(await service.context(device,context)).toEqual(configured);
        expect(owned).toHaveBeenCalledWith({email,activeRole:device.role},device.id);expect(claims).toHaveBeenCalledWith(email);
        expect(requireGrant).toHaveBeenCalledWith(device,context);expect(infer).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    });
    it('Батч использует реальный тег карточки и возвращает точный alias, не credentials',async()=>{
        const result=await service.embed(device,input);
        expect(infer).toHaveBeenCalledWith(configured.model,'embed',{input:input.input,truncate:false},expect.any(AbortSignal));
        expect(result).toEqual({object:'list',model:alias,data:[{object:'embedding',index:0,embedding:[1,0,0]},{object:'embedding',index:1,embedding:[0,1,0]}],usage:{prompt_tokens:4,total_tokens:4}});
        expect(requireGrant).toHaveBeenCalledTimes(2);expect(owned).toHaveBeenCalledTimes(2);expect(claims).toHaveBeenCalledTimes(2);
    });
    it.each(['binding','instance','rights','device','model','alias'])('Изменение %s блокирует доступ до runtime',async change=>{
        if(change==='binding')owned.mockResolvedValue({...device,report:{bindings:[{projectId,bindingId:'c'.repeat(64),instanceId,valid:true}]}});
        if(change==='instance')owned.mockResolvedValue({...device,report:{bindings:[{projectId,bindingId,instanceId:'22222222-2222-4222-8222-222222222222',valid:true}]}});
        if(change==='rights')claims.mockResolvedValue({email,userRoles:['Разработчик'],projects:[]});
        if(change==='device')owned.mockRejectedValue(Object.assign(Error('Устройство отозвано'),{status:403}));
        if(change==='model')requireGrant.mockRejectedValue(Object.assign(Error('Модель снята с проекта'),{status:409}));
        await expect(service.embed(device,{...input,...(change==='alias'?{model:'wrong'}:{})})).rejects.toMatchObject({status:change==='rights'||change==='device'?403:409});
        expect(infer).not.toHaveBeenCalled();
    });
    it.each(['rights','device','model'])('Отзыв %s во время inference не выдаёт уже рассчитанные векторы',async change=>{
        infer.mockImplementation(async()=>{
            if(change==='rights')claims.mockResolvedValue({email,userRoles:['Разработчик'],projects:[]});
            if(change==='device')owned.mockRejectedValue(Object.assign(Error('Устройство отозвано'),{status:403}));
            if(change==='model')requireGrant.mockRejectedValue(Object.assign(Error('Модель изменилась'),{status:409}));
            return {embeddings:[[1,0,0],[0,1,0]]};
        });
        await expect(service.embed(device,input)).rejects.toMatchObject({status:change==='model'?409:403});
        expect(infer).toHaveBeenCalledOnce();
    });
    it.each(['disabled','unavailable'])('Флаг %s блокирует только inference, контекст остаётся читаемым',async mode=>{
        vi.mocked(fetch).mockImplementation(async()=>Response.json(evaluateFeatureFlags({...defaultFeatureFlags(),model_hosting:mode!=='disabled'})));
        if(mode==='unavailable')vi.mocked(fetch).mockRejectedValue(Error('Synthetic unavailable'));
        await expect(service.context(device,context)).resolves.toEqual(configured);
        await expect(service.embed(device,input)).rejects.toMatchObject({status:mode==='disabled'?403:503});expect(infer).not.toHaveBeenCalled();
    });
    it.each([[],[[1,0,0]],[[0,0,0],[0,1,0]],[[1,NaN,0],[0,1,0]],[[1,0],[0,1]]])('Неполный или повреждённый ответ не выдаётся: %j',async embeddings=>{
        infer.mockResolvedValue({embeddings});await expect(service.embed(device,input)).rejects.toMatchObject({status:503});
    });
    it('Закрытый запрос не начинает inference',async()=>{
        const abort=new AbortController();abort.abort();await expect(service.embed(device,input,abort.signal)).rejects.toThrow();expect(infer).not.toHaveBeenCalled();
    });
    it('Ошибка runtime не раскрывает его URL или содержимое запроса',async()=>{
        infer.mockRejectedValue(Error('Secret text at http://private.test'));
        await expect(service.embed(device,input)).rejects.toMatchObject({status:503,message:'Модель не выполнила embedding-запрос. Проверьте хостинг и повторите действие.'});
    });
});
describe('Строгие DTO выбора и батча',()=>{
    it.each([{expectedRevision:0},{expectedRevision:-1,modelId:null},{expectedRevision:0,modelId:null,url:'http://private.test'},null])('Не принимает повреждённый PATCH: %j',value=>{
        expect(()=>projectEmbeddingUpdate(value)).toThrow();
    });
    it.each([{...input,url:'http://private.test'},{...input,expectedRevision:0},{...input,expectedModelPin:'latest'},
        {...input,instanceId:'other'},{...input,input:Array(65).fill('text')},{...input,input:'x'.repeat(256*1024)},
        {...input,input:['']},{...input,input:[]}])('Не принимает непроверяемый запрос embedding',value=>{
        expect(()=>deviceEmbeddingInput(value,true)).toThrow();
    });
});
