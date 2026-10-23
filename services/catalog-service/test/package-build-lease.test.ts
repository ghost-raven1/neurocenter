import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {AccessDb} from '../src/access/access-db';
import type {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import type {CatalogService} from '../src/catalog/catalog.service';

const state=vi.hoisted(()=>({clients:[] as Array<{query:ReturnType<typeof vi.fn>;release:ReturnType<typeof vi.fn>}>,available:false,pool:{query:vi.fn(),connect:vi.fn(),end:vi.fn()}}));
vi.mock('../src/database/pool',()=>({createPool:()=>state.pool}));
import {PackageBuildService} from '../src/package-build/package-build.service';

describe('Сборщик восстанавливает единственного владельца после потери PostgreSQL lease',()=>{
    let service:PackageBuildService;
    let destroyed=false;
    const attempts=()=>state.clients.flatMap(client=>client.query.mock.calls).filter(([sql])=>String(sql).includes('pg_try_advisory_lock')).length;
    beforeEach(()=>{
        vi.useFakeTimers();state.clients=[];state.available=false;destroyed=false;vi.clearAllMocks();
        state.pool.query.mockResolvedValue({rows:[]});state.pool.end.mockResolvedValue(undefined);
        state.pool.connect.mockImplementation(async()=>{
            const client=Object.assign(new EventEmitter(),{query:vi.fn(async(sql:string)=>({rows:sql.includes('EXTRACT(EPOCH')?[{lock_ms:'0',statement_ms:'0'}]:sql.includes('pg_try_advisory_lock')?[{locked:state.available}]:[]})),release:vi.fn()});
            state.clients.push(client);return client;
        });
        service=new PackageBuildService({} as AccessDb,{} as RuntimeArtifacts,{ensureSchema:vi.fn()} as unknown as CatalogService,{} as never);
        Object.assign(service,{cleanupStages:async()=>{},stagingRoot:async()=>'/unused-lease-stage'});
    });
    afterEach(async()=>{if(!destroyed)await service.onModuleDestroy();vi.useRealTimers();});
    it('Уже запущенная standby-реплика получает освободившийся lock без перезапуска',async()=>{
        await service.onModuleInit();expect(attempts()).toBe(1);
        expect(state.clients.flatMap(client=>client.query.mock.calls).some(([sql])=>String(sql).includes("SET state='FAILED'"))).toBe(false);
        state.available=true;await vi.advanceTimersByTimeAsync(1000);
        expect(attempts()).toBe(2);
        expect(state.clients.flatMap(client=>client.query.mock.calls).filter(([sql])=>String(sql).includes("SET state='FAILED'"))).toHaveLength(1);
        expect((service as unknown as{lease?:unknown}).lease).toBeDefined();
    });
    it('После потери lease ждёт завершения старого worker перед новой обработкой',async()=>{
        state.available=true;await service.onModuleInit();
        let drain:()=>void=()=>{};const worker=new Promise<void>(resolve=>{drain=resolve;});Object.assign(service,{worker});
        (state.clients[0] as unknown as EventEmitter).emit('error',new Error('Сессия PostgreSQL завершена'));
        expect((service as unknown as{lease?:unknown}).lease).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1000);expect(attempts()).toBe(1);
        drain();await vi.advanceTimersByTimeAsync(0);
        expect(attempts()).toBe(2);expect((service as unknown as{lease?:unknown}).lease).toBeDefined();
        expect(state.clients[0].release).toHaveBeenCalledExactlyOnceWith(true);
    });
    it('После потери lease ждёт завершения приёма до нового acquire',async()=>{
        state.available=true;await service.onModuleInit();
        let drain:()=>void=()=>{};const admission=new Promise<void>(resolve=>{drain=resolve;});Object.assign(service,{leaseUse:admission});
        (state.clients[0] as unknown as EventEmitter).emit('error',new Error('Сессия PostgreSQL завершена'));
        await vi.advanceTimersByTimeAsync(1000);expect(attempts()).toBe(1);
        drain();await vi.advanceTimersByTimeAsync(0);
        expect(attempts()).toBe(2);expect((service as unknown as{lease?:unknown}).lease).toBeDefined();
    });
    it('Остановка отменяет повторные попытки и не оставляет фоновых PG-подключений',async()=>{
        await service.onModuleInit();await service.onModuleDestroy();destroyed=true;
        await vi.advanceTimersByTimeAsync(60000);expect(attempts()).toBe(1);
        expect(state.pool.end).toHaveBeenCalledOnce();
    });
    it('Ошибка запроса без client.error не оставляет сохранённую очередь без worker',async()=>{
        state.available=true;
        const takeQueued=vi.fn().mockRejectedValueOnce(new Error('Временный statement timeout'))
            .mockResolvedValueOnce({id:'ожидающее-задание'}).mockResolvedValue(undefined);
        const execute=vi.fn().mockResolvedValue(undefined);
        Object.assign(service,{execute});
        const repository=(service as unknown as{repository:{takeQueued:unknown}}).repository;
        repository.takeQueued=takeQueued;
        await service.onModuleInit();await vi.advanceTimersByTimeAsync(0);
        expect(execute).not.toHaveBeenCalled();
        expect(state.clients[0].release).toHaveBeenCalledExactlyOnceWith(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(attempts()).toBe(2);
        expect(execute).toHaveBeenCalledExactlyOnceWith({id:'ожидающее-задание'},'/unused-lease-stage');
        expect(takeQueued).toHaveBeenCalledTimes(3);
    });
    it('Временная недоступность staging при запуске освобождает lock и повторяет восстановление',async()=>{
        state.available=true;
        Object.assign(service,{stagingRoot:vi.fn().mockRejectedValueOnce(new Error('Staging временно недоступен')).mockResolvedValue('/unused-lease-stage')});
        await service.onModuleInit();
        expect((service as unknown as{lease?:unknown}).lease).toBeUndefined();
        expect(state.clients[0].release).toHaveBeenCalledExactlyOnceWith(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(attempts()).toBe(2);
        expect((service as unknown as{lease?:unknown}).lease).toBeDefined();
    });
    it('Подключение, полученное во время shutdown, освобождается без нового захвата lock',async()=>{
        await service.onModuleInit();
        let connect:(client:unknown)=>void=()=>{};
        state.pool.connect.mockImplementationOnce(()=>new Promise(resolve=>{connect=resolve;}));
        await vi.advanceTimersByTimeAsync(1000);
        const stopping=service.onModuleDestroy();destroyed=true;
        const late=Object.assign(new EventEmitter(),{query:vi.fn(),release:vi.fn()});connect(late);
        await stopping;
        expect(late.query).not.toHaveBeenCalled();expect(late.release).toHaveBeenCalledExactlyOnceWith(false);
        expect(state.pool.end).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(60000);expect(attempts()).toBe(1);
    });
});
