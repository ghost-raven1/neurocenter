import 'reflect-metadata';
import {Controller,Get,Module,ServiceUnavailableException} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {ModelChatService} from '../src/model-chat/chat.service';
import {ChatAttachmentStorage} from '../src/model-chat/chat-attachment-storage';
import {ChatObjectStorage} from '../src/model-chat/chat-object-storage';
import type {ModelsService} from '../src/models/models.service';
import type {ModelRuntime} from '../src/models/model-runtime';

afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
const configuration={endpoint:'https://storage.example.test',region:'us-east-1',accessKey:'fixture',secretKey:'fixture',projectBucket:'fixture-project',personalBucket:'fixture-personal'};
const upload=()=>({ownerEmail:'fixture@example.test',projectId:null,conversationId:randomUUID(),bytes:Buffer.from('kept local until storage is verified'),mediaType:'text/plain'});

function fixture(){
    const lease={query:vi.fn(async(sql:string)=>({rows:sql.includes('pg_try_advisory_lock')?[{locked:false}]:[],rowCount:0})),release:vi.fn()};
    const pool={connect:vi.fn(async()=>lease),query:vi.fn(async()=>({rows:[],rowCount:0}))} as unknown as Pool;
    const objects=new ChatObjectStorage(configuration),initialize=vi.spyOn(objects,'initialize');
    const put=vi.spyOn(objects,'put').mockResolvedValue('fixture-version');vi.spyOn(objects,'read').mockResolvedValue(Buffer.from('fixture'));vi.spyOn(objects,'assertPrivate').mockResolvedValue();
    const service=new ModelChatService({ready:vi.fn(async()=>undefined)} as unknown as ModelsService,{} as ModelRuntime);
    service.storage=new ChatAttachmentStorage(pool,{objectStorage:objects});
    return {service,objects,initialize,put,pool};
}

class Health { health(){return {ok:true};} }
Controller('health')(Health);Get()(Health.prototype,'health',Object.getOwnPropertyDescriptor(Health.prototype,'health')!);

describe('Chat storage does not own the Catalog lifecycle',()=>{
    it('initializes a real Nest app even when the configured S3 dependency rejects startup',async()=>{
        const f=fixture();f.initialize.mockRejectedValue(new Error('fixture S3 unavailable'));
        class App {}Module({controllers:[Health],providers:[{provide:ModelChatService,useValue:f.service}]})(App);
        const app=await NestFactory.create(App,{logger:false});
        try{await expect(app.init()).resolves.toBe(app);}
        finally{await app.close();}
    });
    it('opens metadata before a slow storage check finishes and rejects uploads until privacy is verified',async()=>{
        const f=fixture();let release!:()=>void;
        f.initialize.mockReturnValue(new Promise<void>(resolve=>{release=resolve;}));
        let initialized=false;const starting=f.service.onModuleInit().then(()=>{initialized=true;});
        try{
            await Promise.resolve();await Promise.resolve();
            expect(initialized).toBe(true);
            await expect(f.service.storage.stage(upload())).rejects.toBeInstanceOf(ServiceUnavailableException);expect(f.put).not.toHaveBeenCalled();
        }finally{release();await starting;await f.service.onApplicationShutdown();}
    });
    it('retries failed initialization once, then enables uploads and stops its timers on shutdown',async()=>{
        vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval']});
        const f=fixture();f.initialize.mockRejectedValueOnce(new Error('temporary S3 failure')).mockResolvedValue();
        try{
            await f.service.onModuleInit();await vi.advanceTimersByTimeAsync(0);
            await expect(f.service.storage.stage(upload())).rejects.toBeInstanceOf(ServiceUnavailableException);
            expect(f.initialize).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(30000);expect(f.initialize).toHaveBeenCalledTimes(2);
            await expect(f.service.storage.stage(upload())).resolves.toEqual({id:expect.any(String)});
            expect(f.put).toHaveBeenCalledOnce();
        }finally{await f.service.onApplicationShutdown();}
        await vi.advanceTimersByTimeAsync(90000);expect(f.initialize).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
    });
    it('waits for an in-flight initialization on shutdown without resurrecting cleanup or retry',async()=>{
        vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval']});
        const f=fixture();let release!:()=>void,entered!:()=>void;
        const active=new Promise<void>(resolve=>{entered=resolve;});
        f.initialize.mockImplementation(()=>{entered();return new Promise<void>(resolve=>{release=resolve;});});
        const starting=f.service.onModuleInit();await active;let closed=false;
        const closing=f.service.onApplicationShutdown().then(()=>{closed=true;});
        try{await Promise.resolve();await Promise.resolve();expect(closed).toBe(false);}
        finally{release();await starting;await closing;}
        expect(closed).toBe(true);await vi.advanceTimersByTimeAsync(90000);expect(f.initialize).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    });
});
