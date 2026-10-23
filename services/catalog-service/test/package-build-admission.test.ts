vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ConflictException,ForbiddenException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import type {AccessDb} from '../src/access/access-db';
import type {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import type {CatalogService} from '../src/catalog/catalog.service';
import type {BuildRow} from '../src/package-build/package-build.model';

const mocks=vi.hoisted(()=>({pool:{query:vi.fn(),connect:vi.fn(),end:vi.fn()},reserve:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>mocks.pool}));
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:mocks.reserve}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:vi.fn()}));
import {PackageBuildService} from '../src/package-build/package-build.service';

function deferred(){let resolve:()=>void=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
const actor={email:'admission@example.test',activeRole:'Главный админ'};
const request=()=>({requestKey:randomUUID(),kind:'plugin',name:'Изолированная проверка приёма',description:'Без сборки',
    targets:['darwin-arm64'],source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default async()=>({})'}]}});

describe('Приём сборки не переживает владельца и передаёт очередь единственному worker',()=>{
    let service:PackageBuildService;
    let lease:PoolClient;
    let worker:ReturnType<typeof deferred>;
    let unblock:()=>void;
    let destroyed:boolean;
    let repository:Record<'existing'|'enqueue'|'takeQueued'|'cancel'|'cancelRequest'|'evidence',ReturnType<typeof vi.fn>>;
    beforeEach(()=>{
        vi.clearAllMocks();mocks.pool.query.mockResolvedValue({rows:[]});mocks.reserve.mockResolvedValue(vi.fn());
        lease={query:vi.fn().mockResolvedValue({rows:[]})} as unknown as PoolClient;
        worker=deferred();unblock=()=>{};destroyed=false;
        service=new PackageBuildService({claims:vi.fn().mockResolvedValue({userRoles:['Главный админ']})} as unknown as AccessDb,
            {} as RuntimeArtifacts,{} as CatalogService,{} as never);
        repository={existing:vi.fn(),enqueue:vi.fn(),takeQueued:vi.fn(),cancel:vi.fn(),cancelRequest:vi.fn(),evidence:vi.fn(async()=>({runtimeVerification:null,runtimeVerificationAttempt:null,agentSteps:[]}))};
        Object.assign(service,{lease,repository,stagingRoot:async()=>'/unused-admission-stage',execute:vi.fn(()=>worker.promise)});
    });
    afterEach(async()=>{unblock();worker.resolve();if(!destroyed)await service.onModuleDestroy();});
    it.each(['55P03','57014'])('SQL %s при приёме даёт безопасный 503 и сохраняет причину без запуска worker',async code=>{
        const raw=Object.assign(new Error('private SQL details: tool_source_uploads'),{code});
        repository.enqueue.mockRejectedValue(raw);
        const error=await service.create(actor,request()).catch(error=>error);
        expect(error).toMatchObject({status:503,cause:raw});expect(error.cause).toBe(raw);
        expect(error.getResponse()).toEqual({statusCode:503,error:'Service Unavailable',
            message:'Сервер не подтвердил результат запроса. Проверьте его состояние или повторите сохранённый запрос.'});
        expect((service as unknown as{execute:ReturnType<typeof vi.fn>}).execute).not.toHaveBeenCalled();
        expect(repository.takeQueued).not.toHaveBeenCalled();
    });
    it.each(['cancel','cancelRequest'] as const)('%s: SQL deadline не подтверждает отмену работающего процесса',async method=>{
        const key=randomUUID(),cancel=vi.fn();Object.assign(service,{activeBuild:{id:key,cancellation:{cancel,stop:vi.fn()}}});
        for(const code of ['55P03','57014']){
            const raw=Object.assign(new Error('private SQL cancellation lock'),{code});repository[method].mockRejectedValue(raw);
            const error=await service[method](actor,key).catch(error=>error);
            expect(error).toMatchObject({status:503,cause:raw});expect(error.cause).toBe(raw);
            expect(error.getResponse().message).toContain('не подтвердил результат');
            expect(error.getResponse().message).not.toContain(raw.message);expect(cancel).not.toHaveBeenCalled();
        }
    });
    it.each(['create','cancel','cancelRequest'] as const)('%s: проверенные 403/409 и прочие ошибки не маскируются как deadline',async method=>{
        const call=()=>method==='create'?service.create(actor,request()):service[method](actor,randomUUID());
        for(const raw of [new ForbiddenException('Доступ отозван'),new ConflictException('Запрос уже отменён'),Object.assign(new Error('DB unavailable'),{code:'08006'})]){
            repository[method==='create'?'enqueue':method].mockRejectedValue(raw);
            await expect(call()).rejects.toBe(raw);
        }
    });
    it('Потеря lease за staging barrier даёт 503 без enqueue',async()=>{
        const inside=deferred(),barrier=deferred();unblock=barrier.resolve;
        Object.assign(service,{stagingRoot:async()=>{inside.resolve();await barrier.promise;return'/unused-admission-stage';}});
        repository.enqueue.mockResolvedValue({id:randomUUID(),state:'QUEUED'});
        const incoming=service.create(actor,request());void incoming.catch(()=>undefined);
        await inside.promise;Object.assign(service,{lease:undefined});barrier.resolve();
        await expect(incoming).rejects.toMatchObject({status:503});
        expect(repository.enqueue).not.toHaveBeenCalled();
    });
    it('Shutdown ждёт приём, запрещает его commit и затем закрывает pool',async()=>{
        const inside=deferred(),barrier=deferred();unblock=barrier.resolve;
        Object.assign(service,{stagingRoot:async()=>{inside.resolve();await barrier.promise;return'/unused-admission-stage';}});
        const incoming=service.create(actor,request());void incoming.catch(()=>undefined);
        await inside.promise;const stopping=service.onModuleDestroy();
        await new Promise(resolve=>setImmediate(resolve));expect(mocks.pool.end).not.toHaveBeenCalled();
        barrier.resolve();await expect(incoming).rejects.toMatchObject({status:503});await stopping;destroyed=true;
        expect(repository.enqueue).not.toHaveBeenCalled();expect(mocks.pool.end).toHaveBeenCalledOnce();
    });
    it.each([false,true])('Конкурентные запросы (один ключ: %s) ждут commit и передачи worker',async sameKey=>{
        const inside=deferred(),barrier=deferred();unblock=barrier.resolve;
        const first=request(),second=sameKey?first:request();const saved:BuildRow[]=[];
        repository.existing.mockImplementation(async(_actor:string,key:string)=>saved.find(row=>row.request_key===key));
        repository.enqueue.mockImplementation(async(_actor:string,key:string,hash:string,config:BuildRow['config'])=>{
            inside.resolve();await barrier.promise;
            const previous=saved.find(row=>row.request_key===key);if(previous)return previous;
            const row={id:randomUUID(),actor:actor.email,request_key:key,request_hash:hash,config,state:'QUEUED',percent:0} as BuildRow;
            saved.push(row);return row;
        });
        repository.takeQueued.mockImplementation(async()=>saved.shift());
        const incoming=service.create(actor,first);await inside.promise;
        const concurrent=service.create(actor,second);void concurrent.catch(()=>undefined);
        await new Promise(resolve=>setImmediate(resolve));
        const callsBeforeCommit=repository.enqueue.mock.calls.length;
        barrier.resolve();const result=await incoming;
        if(sameKey){expect(await concurrent).toMatchObject({id:result.id});}
        else{expect(await concurrent).not.toMatchObject({id:result.id});}
        expect(callsBeforeCommit).toBe(1);
        expect(repository.enqueue).toHaveBeenCalledWith(actor.email,first.requestKey,expect.any(String),expect.any(Object),lease,expect.any(Function));
        expect(repository.enqueue).toHaveBeenCalledTimes(2);
        await new Promise(resolve=>setImmediate(resolve));
        expect((service as unknown as{execute:ReturnType<typeof vi.fn>}).execute).toHaveBeenCalledOnce();
        worker.resolve();
        await new Promise(resolve=>setImmediate(resolve));
        expect((service as unknown as{execute:ReturnType<typeof vi.fn>}).execute).toHaveBeenCalledTimes(sameKey?1:2);
    });
});
