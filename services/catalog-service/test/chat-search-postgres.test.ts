import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {ConflictException,ForbiddenException} from '@nestjs/common';
import type {ModelsService} from '../src/models/models.service';
import {ModelRuntime} from '../src/models/model-runtime';
import type {OllamaClient} from '../src/models/ollama-client';
import type {RemoteConnectionService} from '../src/models/remote-connection.service';
import type {IModel} from '../src/models/model.types';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import {ChatSearchService} from '../src/chat-search/chat-search.service';
import {CHAT_SEARCH_SCHEMA_SQL} from '../src/chat-search/chat-search.schema';
import {CHAT_SEARCH_SCHEMA_CONTRACT} from '../src/chat-search/chat-search.schema-contract';
import {assertChatSearchSchema} from '../src/chat-search/chat-search.schema-verification';
import {CATALOG_SCHEMA_FACTS_SQL} from '../src/database/schema-catalog';
import {DEFAULT_PROJECT_CHAT_ROOM} from '../src/project-chat/project-chat.types';
import {chatSearchFixture} from './chat-search-postgres.fixture';
const flags=vi.hoisted(()=>({enabled:true}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>{if(!flags.enabled)throw new ForbiddenException('Feature disabled');})}));
const adminUrl=process.env.CHAT_SEARCH_TEST_ADMIN_URL,actor='semantic@fixture.test',token=randomUUID();
const request=(role='Разработчик')=>({headers:{'x-neurocenter-internal':token,'x-bridge-actor':encodeURIComponent(JSON.stringify({email:actor,activeRole:role}))}} as Request);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};};
describe.skipIf(!adminUrl).sequential('Semantic chat owner — disposable PostgreSQL and vector fixtures',()=>{
    let f:Awaited<ReturnType<typeof chatSearchFixture>>,service:ChatSearchService,project:string,model:IModel,provider:ReturnType<typeof vi.fn>;
    let prepare:()=>Promise<void>;
    const input=(extra={})=>({requestKey:randomUUID(),modelId:model.id,expectedModelPin:projectEmbeddingPin(model),consent:true,...extra});
    async function settle(id:string){const deadline=Date.now()+8000;for(;;){const job=await service.get(request(),project,id);if(job.state!=='RUNNING')return job;if(Date.now()>deadline)throw new Error('Fixture job timed out');await new Promise(resolve=>setImmediate(resolve));}}
    async function rawSettled(id:string){const deadline=Date.now()+8000;for(;;){const row=(await f.pool.query('SELECT state FROM chat_search_jobs WHERE id=$1',[id])).rows[0];if(row.state!=='RUNNING')return row;if(Date.now()>deadline)throw new Error('Fixture job timed out');await new Promise(resolve=>setImmediate(resolve));}}
    async function index(extra={}){const job=await service.create(request(),project,'index',input(extra));return settle(job.id);}
    async function search(extra={}){const job=await service.create(request(),project,'search',input({query:'транспорт ремонт',...extra}));return settle(job.id);}
    async function message(content:string,room=DEFAULT_PROJECT_CHAT_ROOM){
        const id=randomUUID();await f.pool.query(`INSERT INTO project_chat_messages(id,project_id,room_id,kind,content,author_email,author_name,author_role,status,request_key,request_hash,generation)
          VALUES($1,$2,$3,'user',$4,$5,'Fixture','Разработчик','done',$6,$7,$8)`,[id,project,room,content,actor,randomUUID(),'a'.repeat(64),randomUUID()]);return id;
    }
    beforeAll(async()=>{
        f=await chatSearchFixture(adminUrl!);const before=(await f.pool.query(CATALOG_SCHEMA_FACTS_SQL)).rows;
        await f.pool.query(CHAT_SEARCH_SCHEMA_SQL);const after=(await f.pool.query(CATALOG_SCHEMA_FACTS_SQL)).rows;
        for(const fact of before)expect(after.find(item=>item.kind===fact.kind&&item.id===fact.id)).toEqual(fact);
        const keys=new Set(before.map(row=>row.kind+':'+row.id)),contract=after.filter(row=>!keys.has(row.kind+':'+row.id)).sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
        expect(CHAT_SEARCH_SCHEMA_CONTRACT.length).toBeGreaterThan(0);
        expect(contract).toEqual(CHAT_SEARCH_SCHEMA_CONTRACT);await assertChatSearchSchema(f.pool);
        await f.pool.query('INSERT INTO platform_users(email) VALUES($1)',[actor]);vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',token);
    });
    beforeEach(async()=>{
        flags.enabled=true;project='prj-semantic-'+randomUUID();prepare=async()=>{};
        model={id:'model-semantic',name:'Fixture embeddings',description:'Vectors only',capability:'embedding',runtime:'ollama',model:'fixture:1',manifestSha256:'a'.repeat(64),dimension:2,source:'custom',revision:1,createdAt:'2026-10-24',updatedAt:'2026-10-24'};
        await f.pool.query('INSERT INTO projects(id,name) VALUES($1,$1)',[project]);await f.pool.query("INSERT INTO project_members VALUES($1,$2,'Fixture','Разработчик')",[project,actor]);
        await f.pool.query('INSERT INTO project_chat_rooms(project_id) VALUES($1)',[project]);await f.pool.query('INSERT INTO project_models VALUES($1,$2)',[project,model.id]);
        provider=vi.fn(async(_model:unknown,_endpoint:unknown,body:{input:string[]})=>{await prepare();return {embeddings:body.input.map(text=>text.includes('Грузовик')||text==='транспорт ремонт'?[1,0]:[0,1])};});
        const local={infer:(...args:Parameters<typeof provider>)=>provider(...args)} as unknown as OllamaClient;
        const runtime=new ModelRuntime(local,{} as RemoteConnectionService);
        const models={pool:f.pool,getUsable:async(id:string,_req:Request,project:string)=>{
            if(!(await f.pool.query('SELECT 1 FROM project_models WHERE project_id=$1 AND model_id=$2',[project,id])).rowCount)throw new ForbiddenException('Model unassigned');return model;
        }} as unknown as ModelsService;
        service=new ChatSearchService(models,runtime);
    });
    afterEach(async()=>{await service.onModuleDestroy();});
    afterAll(async()=>{if(f)expect(await f.dispose()).toMatchObject({dropped:true,originalDatabasesPreserved:true,newDatabasesRemaining:[]});vi.unstubAllEnvs();});
    it('fails schema readiness after the revision trigger is removed',async()=>{
        const db=await f.pool.connect();
        try{await db.query('BEGIN');await db.query('DROP TRIGGER chat_search_revision ON project_chat_messages');
            await expect(assertChatSearchSchema(db)).rejects.toThrow('Схема семантического поиска не готова.');
        }finally{await db.query('ROLLBACK');db.release();}
        await assertChatSearchSchema(f.pool);
    });
    it('indexes real vectors and retrieves a semantically matching message with no lexical query overlap',async()=>{
        const wanted=await message('Грузовик отвезли механику'),other=await message('Согласовали бюджет проекта');
        expect(await index()).toMatchObject({state:'SUCCEEDED',indexedChunks:1,hasMore:true});expect(await index()).toMatchObject({state:'SUCCEEDED',indexedChunks:1,hasMore:false});
        const result=await search();expect(result.state).toBe('SUCCEEDED');expect(result.results?.map(hit=>hit.messageId)).toEqual([wanted]);expect(result.results?.[0].content).toBe('Грузовик отвезли механику');expect(result.results?.some(hit=>hit.messageId===other)).toBe(false);
        expect((await f.pool.query('SELECT count(*) FROM chat_search_vectors WHERE project_id=$1',[project])).rows[0].count).toBe('2');
        expect((await f.pool.query('SELECT state FROM operations WHERE operation_id=$1',['chat-search-'+result.id])).rows[0].state).toBe('SUCCEEDED');
    });
    it('hydrates under the existing single-connection owner transaction and retains public source locks',async()=>{
        const id=await message('Грузовик отвезли механику');await index();const result=await search(),calls=provider.mock.calls.length,db=await f.pool.connect();
        try{
            await db.query('BEGIN');expect(f.pool.options.max).toBe(1);
            expect((await service.get(request(),project,result.id,db)).results?.map(hit=>hit.messageId)).toEqual([id]);
            await f.observer.query("SET lock_timeout='100ms'");
            await expect(f.observer.query('DELETE FROM project_chat_messages WHERE id=$1',[id])).rejects.toMatchObject({code:'55P03'});
            await db.query('COMMIT');
            await f.observer.query('DELETE FROM project_chat_messages WHERE id=$1',[id]);
        }finally{await db.query('ROLLBACK');db.release();await f.observer.query("SET lock_timeout='0'");}
        expect((await service.get(request(),project,result.id)).results).toEqual([]);expect(provider).toHaveBeenCalledTimes(calls);
    });
    it('never indexes or returns private messages, including the caller’s own private dialogue',async()=>{
        const room=randomUUID();await f.pool.query(`INSERT INTO project_chat_rooms(project_id,id,title,visibility,creator_email,create_request_key,create_request_hash) VALUES($1,$2,'Secret','PRIVATE',$3,$4,$5)`,[project,room,actor,randomUUID(),'a'.repeat(64)]);
        await message('Грузовик PRIVATE SECRET',room);expect(await index()).toMatchObject({state:'SUCCEEDED',indexedChunks:0,hasMore:false});expect(await search()).toMatchObject({state:'SUCCEEDED',results:[]});expect(provider).not.toHaveBeenCalled();
    });
    it('exact index and query replay recover the durable receipt without additional inference, even with flags off',async()=>{
        await message('Грузовик отвезли механику');const body=input();const created=await service.create(request(),project,'index',body);await settle(created.id);const count=provider.mock.calls.length;
        flags.enabled=false;expect((await service.create(request(),project,'index',body)).id).toBe(created.id);expect(provider).toHaveBeenCalledTimes(count);
        await expect(service.create(request(),project,'index',{...body,limit:1})).rejects.toThrow('Ключ');flags.enabled=true;
        const query=input({query:'транспорт ремонт'}),job=await service.create(request(),project,'search',query);await settle(job.id);const calls=provider.mock.calls.length;
        flags.enabled=false;expect((await service.create(request(),project,'search',query)).results).toHaveLength(1);expect(provider).toHaveBeenCalledTimes(calls);
    });
    it('physical deletion leaves a tombstone and removes cached hits from subsequent job/history replay',async()=>{
        const id=await message('Грузовик отвезли механику');await index();const result=await search();await f.pool.query('DELETE FROM project_chat_messages WHERE id=$1',[id]);
        expect((await service.get(request(),project,result.id)).results).toEqual([]);expect((await f.pool.query('SELECT tombstone FROM chat_search_revisions WHERE message_id=$1',[id])).rows[0].tombstone).toBe(true);
    });
    it('changing a message revision invalidates vectors before retrieval',async()=>{
        const parent=await message('Parent'),id=randomUUID();await f.pool.query(`INSERT INTO project_chat_messages(id,project_id,kind,content,status,source_message_id,generation) VALUES($1,$2,'summary','Грузовик отвезли механику','done',$3,$4)`,[id,project,parent,randomUUID()]);
        await index();await index();const result=await search();expect(result.results?.[0].messageId).toBe(id);
        await f.pool.query("UPDATE project_chat_messages SET content='Совсем новое содержание' WHERE id=$1",[id]);expect((await service.get(request(),project,result.id)).results).toEqual([]);
        expect((await f.pool.query('SELECT count(*) FROM chat_search_vectors WHERE message_id=$1',[id])).rows[0].count).toBe('0');
    });
    it('revoked membership during inference prevents persistence and later retrieval',async()=>{
        await message('Грузовик отвезли механику');const entered=deferred(),release=deferred();prepare=async()=>{entered.resolve();await release.promise;};
        const job=await service.create(request(),project,'index',input());await entered.promise;
        await f.observer.query('DELETE FROM project_members WHERE project_id=$1',[project]);release.resolve();expect((await rawSettled(job.id)).state).toBe('FAILED');
        expect((await f.pool.query('SELECT count(*) FROM chat_search_vectors WHERE project_id=$1',[project])).rows[0].count).toBe('0');await expect(service.get(request(),project,job.id)).rejects.toThrow();
    });
    it('cancellation is durable, ignores a late provider success, and does not permit hidden replay',async()=>{
        await message('Грузовик отвезли механику');const entered=deferred(),release=deferred();prepare=async()=>{entered.resolve();await release.promise;};
        const body=input(),job=await service.create(request(),project,'index',body);await entered.promise;expect((await service.cancel(request(),project,job.id)).state).toBe('CANCELLED');release.resolve();await service.onModuleDestroy();
        expect((await service.create(request(),project,'index',body)).state).toBe('CANCELLED');expect(provider).toHaveBeenCalledTimes(1);expect((await f.pool.query('SELECT count(*) FROM chat_search_vectors WHERE project_id=$1',[project])).rows[0].count).toBe('0');
    });
    it('large public messages progress through explicit bounded batches without skipping the remainder',async()=>{
        await message('Грузовик '+ '界'.repeat(4096));expect(await index({limit:1})).toMatchObject({indexedChunks:1,hasMore:true});expect(await index({limit:1})).toMatchObject({indexedChunks:1,hasMore:true});expect(await index({limit:1})).toMatchObject({indexedChunks:1,hasMore:false});
    });
    it('project cascade deletion does not resurrect revision rows or prevent project removal',async()=>{
        await message('Грузовик отвезли механику');await index();await f.pool.query('DELETE FROM projects WHERE id=$1',[project]);expect((await f.pool.query('SELECT count(*) FROM chat_search_revisions WHERE project_id=$1',[project])).rows[0].count).toBe('0');
    });
    it('rejects a changed embedding pin before any provider dispatch',async()=>{
        await message('Грузовик отвезли механику');const body=input();model={...model,manifestSha256:'b'.repeat(64)};await expect(service.create(request(),project,'index',body)).rejects.toBeInstanceOf(ConflictException);expect(provider).not.toHaveBeenCalled();
    });
});
