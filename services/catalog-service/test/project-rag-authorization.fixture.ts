import {createServer,type Server,type ServerResponse} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Pool} from 'pg';
import type {Request} from 'express';
import {vi} from 'vitest';
import {AccessDb} from '../src/access/access-db';
import {CatalogDb} from '../src/catalog/catalog-db';
import type {CatalogService} from '../src/catalog/catalog.service';
import {ModelsService} from '../src/models/models.service';
import {ProjectRagCoordinator} from '../src/models/project-rag-coordinator';
import {initialGeneration} from '../src/models/project-embedding.repository';
import {backfillModelHistory,modelFromRow} from '../src/models/model-history';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import {migrateCatalog} from '../src/database/migrations';
import {CATALOG_SCHEMA_FACTS_SQL} from '../src/database/schema-catalog';
import {RagDb} from '../../rag-sync-service/src/rag/rag-db';
import {RagService} from '../../rag-sync-service/src/rag/rag.service';
import type {ProjectDatabases} from '../../rag-sync-service/src/rag/project-databases';
import {ragRequestHash} from '../../shared/rag-index-contract.cjs';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {RAG_WRITE_POLICY} from '../../shared/rag-write-authorization.cjs';

const {ownedTestPostgresAdmin}=createRequire(import.meta.url)('../../../scripts/test/owned-postgres.fixture.mjs') as {ownedTestPostgresAdmin:(value:string|undefined)=>URL};
export const connection=process.env.RAG_AUTHORIZATION_TEST_ADMIN_PG_URL;
export type Intent=Parameters<ProjectRagCoordinator['finish']>[0];
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Actual Catalog/RAG code, separate disposable databases, and loopback HTTP; no provider or user data is used. */
export async function ragAuthorizationFixture(){
    const url=ownedTestPostgresAdmin(connection),admin=new Pool({connectionString:url.href,max:1});
    const names=['catalog','index'].map(kind=>'nc_rag_auth_'+kind+'_'+randomUUID().replaceAll('-','')),created:string[]=[];
    let pool:Pool|undefined,observer:Pool|undefined,ragObserver:Pool|undefined,rag:RagDb|undefined,models:ModelsService|undefined,access:AccessDb|undefined,catalog:CatalogDb|undefined,server:Server|undefined;
    const state={off:false,dropBeforeWrite:false,loseWriteAck:false,loseGrantAck:false,oldGrant:false};
    const close=async()=>{
        if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
        await models?.onApplicationShutdown();await access?.onModuleDestroy();await catalog?.close();
        await rag?.close();await ragObserver?.end();await observer?.end();await pool?.end();
        try{for(const name of created)await admin.query('DROP DATABASE '+name);}finally{await admin.end();vi.unstubAllEnvs();}
    };
    try{
        for(const name of names){await admin.query('CREATE DATABASE '+name);created.push(name);}
        url.pathname='/'+names[0];const catalogUrl=url.href;pool=new Pool({connectionString:catalogUrl,max:6});observer=new Pool({connectionString:catalogUrl,max:2});
        url.pathname='/'+names[1];rag=new RagDb({url:url.href});ragObserver=new Pool({connectionString:url.href,max:2});await rag.setup();
        await migrateCatalog(pool,CATALOG_MIGRATIONS.filter(migration=>migration.version<=29));
        const oldHistory=(await pool.query('SELECT version,name,checksum,applied_at FROM catalog_schema_migrations ORDER BY version')).rows;
        const modelId='model-rag-authorization-fixture',descriptor={runtime:'ollama',capability:'embedding',model:'fixture:3',manifestSha256:'a'.repeat(64),dimension:3,description:'',source:'custom'};
        await pool.query('INSERT INTO model_catalog(id,name,descriptor,revision) VALUES($1,$2,$3,1)',[modelId,'Owned RAG authorization fixture',descriptor]);
        await backfillModelHistory(pool);const pin=projectEmbeddingPin(modelFromRow((await pool.query('SELECT * FROM model_catalog WHERE id=$1',[modelId])).rows[0]));
        async function seed({legacy=false,intent=true}:{legacy?:boolean;intent?:boolean}={}){
            const project='prj-'+randomUUID(),id=randomUUID(),email='writer-'+randomUUID()+'@example.test',role='Разработчик';
            await pool!.query('INSERT INTO projects(id,name) VALUES($1,$1)',[project]);
            await pool!.query('INSERT INTO platform_users(email) VALUES($1)',[email]);
            await pool!.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)',[project,email,role]);
            await pool!.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)',[project,modelId,email]);
            const profile={provider:'openai' as const,model:`neurocenter/${modelId}/sha256/${pin}`,dimension:3},context={projectId:project,revision:1,dataRevision:0,generation:initialGeneration(project),profile,snapshot:null};
            await pool!.query('INSERT INTO project_embedding_settings(project_id,revision,model_id,model_pin,dimension,updated_by,active_generation) VALUES($1,1,$2,$3,3,$4,$5)',[project,modelId,pin,email,context.generation]);
            const payload={projectKey:project,expectedGeneration:context.generation,expectedSelectionRevision:1,expectedDataRevision:0,fingerprintVersion:1,indexProfile:profile,
                snapshot:{hash:'b'.repeat(64),rowCount:1,complete:false},chunks:[{id:'owned-row',filePath:'README.md',content:'owned original bytes',contentHash:hash('owned original bytes'),embedding:[1,2,3]}],deletes:[]};
            const body={...payload,requestKey:ragRequestHash(payload)},input={id,payloadHash:ragRequestHash(body),context,payload:body};
            if(intent){
                const fields=legacy?'':',author_email,author_role,write_policy',values=legacy?'':',$7,$8,$9';
                await pool!.query(`INSERT INTO project_rag_sync_intents(id,project_id,request_key,payload_hash,context,payload,state${fields}) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'pending'${values})`,
                    [id,project,body.requestKey,input.payloadHash,JSON.stringify(context),JSON.stringify(body),...(legacy?[]:[email,role,RAG_WRITE_POLICY])]);
            }
            const request={headers:{'x-neurocenter-internal':'owned-rag-token','x-bridge-actor':encodeURIComponent(JSON.stringify({email,activeRole:role}))}} as unknown as Request;
            return{project,id,email,role,input,body,request,
                async intent(){return (await pool!.query<Intent>('SELECT * FROM project_rag_sync_intents WHERE project_id=$1',[project])).rows[0];},
                async revoke(){await observer!.query('DELETE FROM project_members WHERE project_id=$1 AND lower(principal_name)=$2',[project,email]);},
                async restore(){await observer!.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)',[project,email,role]);},
                async observed(){return{intent:(await observer!.query('SELECT state,author_email,author_role,write_policy,payload_hash FROM project_rag_sync_intents WHERE project_id=$1',[project])).rows[0],
                    revision:Number((await observer!.query('SELECT data_revision FROM project_embedding_settings WHERE project_id=$1',[project])).rows[0].data_revision),
                    chunks:(await ragObserver!.query('SELECT content,xmin::text AS version FROM rag_chunks WHERE project_key=$1',[project])).rows,
                    receipts:(await ragObserver!.query('SELECT state,result,xmin::text AS version FROM rag_write_receipts WHERE id=$1',[id])).rows};},
            };
        }
        const legacyPending=await seed({legacy:true}),legacyCommitted=await seed({legacy:true});
        const old=legacyCommitted.input;
        await rag.applyDelta(old.context.projectId,old.context.generation,old.payload.chunks.map(chunk=>({...chunk,description:null,startLine:null,endLine:null,language:null,kind:null,role:null,quirkType:null,tags:null})),[],{indexProfile:old.context.profile,snapshot:old.payload.snapshot},{id:old.id,payloadHash:old.payloadHash});
        await migrateCatalog(pool,CATALOG_MIGRATIONS);
        if(process.env.RAG_AUTHORIZATION_SCHEMA_FACTS_FILE){
            const facts=(await pool.query(`SELECT * FROM (${CATALOG_SCHEMA_FACTS_SQL}) facts WHERE id IN ('project_rag_sync_intents.author_email','project_rag_sync_intents.author_role','project_rag_sync_intents.write_policy','project_rag_sync_intents.project_rag_sync_intents_author_policy_check') ORDER BY kind,id`)).rows;
            await mkdir(path.dirname(process.env.RAG_AUTHORIZATION_SCHEMA_FACTS_FILE),{recursive:true});
            await writeFile(process.env.RAG_AUTHORIZATION_SCHEMA_FACTS_FILE,JSON.stringify(facts,null,2)+'\n');
        }
        vi.stubEnv('CATALOG_PG_URL',catalogUrl);vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','owned-rag-token');
        access=new AccessDb();catalog=new CatalogDb(catalogUrl);
        models=new ModelsService({getProject:(id:string)=>catalog!.getProject(id)} as unknown as CatalogService,access);
        let coordinator:ProjectRagCoordinator;
        const service=new RagService({withProject:async<T>(id:string,action:(db:RagDb,key:string)=>Promise<T>)=>action(rag!,id)} as ProjectDatabases);
        const json=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
        server=createServer((req,res)=>{void(async()=>{
            if(req.headers['x-neurocenter-internal']!=='owned-rag-token'){json(res,403,{message:'Owned fixture token required'});return;}
            const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
            const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):undefined;
            if(req.url==='/internal/feature-flags/evaluated'){json(res,200,evaluateFeatureFlags({...defaultFeatureFlags(),rag_sync:!state.off}));return;}
            if(req.url==='/internal/project-rag/write-authorize'){
                const grant=await coordinator.authorizeWrite(body);
                if(state.loseGrantAck&&body.phase==='write'){state.loseGrantAck=false;res.destroy();return;}
                json(res,200,state.oldGrant?{ok:true}:grant);return;
            }
            if(req.url==='/internal/project-rag/write'){
                if(state.dropBeforeWrite){res.destroy();return;}
                const result=await service.applyDelta(body);
                if(state.loseWriteAck){state.loseWriteAck=false;res.destroy();return;}
                json(res,200,result);return;
            }
            json(res,404,{message:'Unknown owned fixture route'});
        })().catch((error:{getStatus?:()=>number;getResponse?:()=>unknown})=>json(res,error.getStatus?.()??500,error.getResponse?.()??{message:'Owned fixture failure'}));});
        await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',resolve);});
        const address=server.address();if(!address||typeof address==='string')throw Error('Owned fixture has no TCP listener');
        const base='http://127.0.0.1:'+address.port;
        vi.stubEnv('CATALOG_SERVICE_URL',base);vi.stubEnv('RAG_SERVICE_URL',base);vi.stubEnv('FEATURE_FLAGS_SERVICE_URL',base);
        coordinator=new ProjectRagCoordinator(models);
        return{pool,observer,ragObserver,rag,coordinator,service,state,base,seed,legacyPending,legacyCommitted,oldHistory,close};
    }catch(error){await close();throw error;}
}
