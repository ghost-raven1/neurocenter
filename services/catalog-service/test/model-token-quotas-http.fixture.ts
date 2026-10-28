import 'reflect-metadata';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {Module,type INestApplication} from '@nestjs/common';
import {NestFactory,APP_GUARD} from '@nestjs/core';
import {Pool} from 'pg';
import {vi} from 'vitest';
import {AccessDb} from '../src/access/access-db';
import type {IAccessActor} from '../src/access/access.model';
import type {CatalogService} from '../src/catalog/catalog.service';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {migrateCatalog} from '../src/database/migrations';
import {ModelsService} from '../src/models/models.service';
import {ModelInferenceController} from '../src/models/inference.controller';
import {ModelRuntime} from '../src/models/model-runtime';
import {RemoteConnectionService} from '../src/models/remote-connection.service';
import {OllamaClient} from '../src/models/ollama-client';
import {ModelUsageService} from '../src/model-usage/model-usage.service';
import {ModelRateLimitsService} from '../src/model-rate-limits/model-rate-limits.service';
import {ModelApiAdmission} from '../src/model-api-admission/model-api-admission';
import {ModelTokenQuotasController} from '../src/model-token-quotas/model-token-quotas.controller';
import {ModelTokenQuotasService} from '../src/model-token-quotas/model-token-quotas.service';
import {FeaturePolicyGuard} from '../src/features/feature-policy.guard';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';

export const quotaHttpAdminUrl=process.env.MODEL_TOKEN_QUOTA_TEST_ADMIN_PG_URL;
export const quotaHttpMain:IAccessActor={email:'quota-http-admin@example.test',activeRole:'Главный админ'};
export const quotaHttpOther:IAccessActor={email:'quota-http-other@example.test',activeRole:'Главный админ'};
export const quotaHttpUser:IAccessActor={email:'quota-http-user@example.test',activeRole:'Разработчик'};
export const quotaHttpRemovedUser='quota-http-removed@example.test';
export const quotaHttpModelId='model-quota-http',quotaHttpRemovedModel='model-quota-http-removed',quotaHttpUnsupported='model-quota-http-unsupported';
const descriptor={description:'Owned HTTP fixture',runtime:'remote-openai',model:'quota-http/model',modelVersion:'1',capability:'chat',dimension:null,
    manifestSha256:null,verificationSha256:'a'.repeat(64),source:'custom'};
const quotaColumns=['quota_state','quota_reserved_tokens','quota_debit_tokens','quota_admitted_at','quota_metadata','quota_settlement_digest'];
export const quotaHttpInput=(tokenLimit=10000,expectedRevision=0)=>({requestKey:randomUUID(),expectedRevision,enabled:true,tokenLimit,periodMs:86400000});
export const quotaHttpPath=(model=quotaHttpModelId,email=quotaHttpUser.email)=>'/api/models/'+model+'/token-quotas/'+encodeURIComponent(email);

/** Only synthetic internal identity and an own HTTP provider are fake; controllers, auth SQL and quota owners are real. */
export async function quotaHttpFixture(){
    let target:URL;try{target=new URL(quotaHttpAdminUrl??'');}catch{throw Error('An explicit own quota PostgreSQL admin URL is required.');}
    if(!['postgres:','postgresql:'].includes(target.protocol)||target.hostname!=='127.0.0.1'||!target.port||target.port==='5432'||target.pathname!=='/postgres'||target.search||target.hash)
        throw Error('HTTP quota QA refuses non-owned/non-loopback/default5432 database targets.');
    const database='nc_token_quota_http_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:target.toString(),max:1}),legacyId=randomUUID();
    let pool:Pool|undefined,app:INestApplication|undefined,provider:http.Server|undefined,access:AccessDb|undefined,models:ModelsService|undefined,
        usage:ModelUsageService|undefined,rates:ModelRateLimitsService|undefined,quota:ModelTokenQuotasService|undefined,created=false,appOwnsModels=false;
    const originalFetch=globalThis.fetch,oldEnv=new Map(['CATALOG_PG_URL','NEUROCENTER_INTERNAL_TOKEN','FEATURE_FLAGS_SERVICE_URL','SSO_DISABLE'].map(key=>[key,process.env[key]]));
    const token=randomBytes(24).toString('hex'),flags=defaultFeatureFlags(),flagsUrl='http://127.0.0.1:9/quota-http-'+randomUUID();
    flags.user_model_token_quotas=true;flags.model_rate_limits=false;
    let providerUrl='',apiUrl='';const reported={input:1000,output:6000};
    let nextProviderHold:{arrived:()=>void;failed:(error:unknown)=>void;wait:Promise<void>;release:()=>void}|undefined;
    const providerReleases=new Set<()=>void>();
    const holdNextProvider=()=>{
        if(nextProviderHold)throw Error('A provider response is already held.');
        let arrived!:()=>void,failed!:(error:unknown)=>void,settle!:()=>void;
        const entered=new Promise<void>((resolve,reject)=>{arrived=resolve;failed=reject;});entered.catch(()=>undefined);
        const wait=new Promise<void>(resolve=>settle=resolve);
        const release=()=>{settle();providerReleases.delete(release);if(nextProviderHold?.release===release)nextProviderHold=undefined;};
        nextProviderHold={arrived,failed,wait,release};providerReleases.add(release);return {entered,release};
    };
    const providerCalls:Array<{body:Record<string,unknown>;authorizationPresent:boolean;receipts:Array<Record<string,unknown>>}>=[];
    const history=async()=>{if(!pool)throw Error('Owned DB is not ready.');return(await pool.query('SELECT version,name,checksum,applied_at FROM catalog_schema_migrations ORDER BY version')).rows;};
    async function close(){
        const failures:string[]=[];
        const finish=async(name:string,action:()=>Promise<unknown>)=>{try{await action();}catch{failures.push(name);}};
        for(const release of providerReleases)release();
        await finish('nest',async()=>app?.close());
        await finish('usage',async()=>usage?.onApplicationShutdown());
        await finish('rates',async()=>rates?.onApplicationShutdown());
        if(!appOwnsModels)await finish('models',async()=>models?.onApplicationShutdown());
        await finish('access',async()=>access?.onModuleDestroy());
        if(provider?.listening){provider.closeAllConnections();await finish('provider',()=>new Promise<void>((resolve,reject)=>provider!.close(error=>error?reject(error):resolve())));}
        await finish('fixture-pool',async()=>pool?.end());
        if(created)await finish('fixture-database',async()=>admin.query('DROP DATABASE '+database));
        await finish('admin',()=>admin.end());
        vi.unstubAllGlobals();
        for(const[key,value]of oldEnv)if(value===undefined)delete process.env[key];else process.env[key]=value;
        if(failures.length)throw Error('Owned HTTP fixture cleanup failed: '+failures.join(','));
    }
    try{
        await admin.query('CREATE DATABASE '+database);created=true;target.pathname='/'+database;
        const databaseUrl=target.toString();pool=new Pool({connectionString:databaseUrl,max:6,connectionTimeoutMillis:1000,query_timeout:10000});
        await migrateCatalog(pool,CATALOG_MIGRATIONS.filter(migration=>migration.version<=45));
        await pool.query(`INSERT INTO model_usage_calls(id,worker_id,model_id,model_name,provider,endpoint,purpose,actor_email,status,input_tokens,output_tokens,latency_ms,started_at,finished_at,lease_until)
            VALUES($1,$2,'model-legacy-http','Historical own row','remote-openai','chat','direct','legacy-http@example.test','success',3,5,1,now()-interval '1hour',now()-interval '1hour',NULL)`,[legacyId,randomUUID()]);
        const prefixHistory=await history(),legacyBefore=(await pool.query('SELECT to_jsonb(receipt) AS row FROM model_usage_calls receipt WHERE id=$1',[legacyId])).rows[0].row;
        await ensureCatalogSchema(pool);
        provider=http.createServer(async(request,response)=>{
            const held=nextProviderHold;nextProviderHold=undefined;
            try{
                if(request.method!=='POST'||request.url!=='/v1/chat/completions'){held?.failed(Error('Unexpected owned provider route'));held?.release();response.writeHead(404);response.end();return;}
                const chunks:Buffer[]=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>16384)throw Error('Fixture body limit');chunks.push(Buffer.from(chunk));}
                const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
                const receipts=(await pool!.query("SELECT id,actor_email,model_id,quota_state,quota_reserved_tokens,dispatch_count FROM model_usage_calls WHERE actor_email=$1 AND status='pending'",[quotaHttpUser.email])).rows;
                providerCalls.push({body,authorizationPresent:request.headers.authorization!==undefined,receipts});
                if(held){held.arrived();await held.wait;}
                response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({model:descriptor.model,
                    choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'owned HTTP answer'}}],usage:{prompt_tokens:reported.input,completion_tokens:reported.output}}));
            }catch(error){held?.failed(error);held?.release();response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:'Owned fixture provider failed'}));}
        });
        await new Promise<void>((resolve,reject)=>{provider!.once('error',reject);provider!.listen(0,'127.0.0.1',resolve);});
        providerUrl='http://127.0.0.1:'+(provider.address() as {port:number}).port;
        process.env.CATALOG_PG_URL=databaseUrl;process.env.NEUROCENTER_INTERNAL_TOKEN=token;process.env.FEATURE_FLAGS_SERVICE_URL=flagsUrl;process.env.SSO_DISABLE='false';
        vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
            const url=String(input instanceof Request?input.url:input);
            if(url===flagsUrl+'/internal/feature-flags/evaluated')return Response.json(evaluateFeatureFlags(flags));
            if(url.startsWith(providerUrl+'/')||apiUrl&&url.startsWith(apiUrl+'/'))return originalFetch(input,init);
            throw Error('An unowned HTTP destination was refused by the quota fixture.');
        });
        const seed=async()=>{
            await pool!.query('TRUNCATE model_user_token_quota_requests,model_user_token_quotas');await pool!.query('DELETE FROM model_usage_calls WHERE id<>$1',[legacyId]);
            for(const[email,main]of [[quotaHttpMain.email,true],[quotaHttpOther.email,true],[quotaHttpUser.email,false],[quotaHttpRemovedUser,false]] as const)
                await pool!.query('INSERT INTO platform_users(email,is_main_admin,enabled) VALUES($1,$2,true) ON CONFLICT(email) DO UPDATE SET is_main_admin=EXCLUDED.is_main_admin,enabled=true',[email,main]);
            await pool!.query("INSERT INTO projects(id,name) VALUES('prj-quota-http','Owned quota HTTP') ON CONFLICT DO NOTHING");
            await pool!.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES('prj-quota-http',$1,$1,'Owned member','Разработчик') ON CONFLICT DO NOTHING",[quotaHttpUser.email]);
            for(const[id,body]of [[quotaHttpModelId,descriptor],[quotaHttpRemovedModel,descriptor],[quotaHttpUnsupported,{...descriptor,runtime:'device-codex'}]] as const)
                await pool!.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET descriptor=EXCLUDED.descriptor,archived_at=NULL',[id,JSON.stringify(body)]);
            await pool!.query("INSERT INTO project_models(project_id,model_id,added_by) VALUES('prj-quota-http',$1,$2) ON CONFLICT DO NOTHING",[quotaHttpModelId,quotaHttpMain.email]);
            await pool!.query(`INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,semantic_sha,verified_at,options,timeout_ms)
                VALUES($1,1,$2,false,'none',$3,now(),'{}',5000) ON CONFLICT(model_id,revision) DO UPDATE SET base_url=EXCLUDED.base_url,revoked_at=NULL`,[quotaHttpModelId,providerUrl+'/v1',descriptor.verificationSha256]);
            flags.user_model_token_quotas=true;flags.model_catalog=true;providerCalls.length=0;
        };
        await seed();
        access=new AccessDb();const catalog={ensureSchema:()=>ensureCatalogSchema(pool!)};
        models=new ModelsService(catalog as unknown as CatalogService,access);usage=new ModelUsageService(models);rates=new ModelRateLimitsService(models);
        const admission=new ModelApiAdmission(rates,usage),remote=new RemoteConnectionService(models,usage,admission),local=new OllamaClient({usage,admission}),runtime=new ModelRuntime(local,remote,usage);
        quota=new ModelTokenQuotasService(models,usage);await access.ready();await usage.onModuleInit();
        Reflect.defineMetadata('design:paramtypes',[ModelTokenQuotasService],ModelTokenQuotasController);
        Reflect.defineMetadata('design:paramtypes',[ModelsService,ModelRuntime],ModelInferenceController);
        class HttpFixture{}Module({controllers:[ModelTokenQuotasController,ModelInferenceController],providers:[{provide:ModelTokenQuotasService,useValue:quota},
            {provide:ModelsService,useValue:models},{provide:ModelRuntime,useValue:runtime},{provide:APP_GUARD,useClass:FeaturePolicyGuard}]})(HttpFixture);
        app=await NestFactory.create(HttpFixture,{logger:false});appOwnsModels=true;await app.listen(0,'127.0.0.1');apiUrl=await app.getUrl();
        return {pool,service:quota,usage,admission,providerCalls,holdNextProvider,legacyId,prefixHistory,legacyBefore,history,
            reset:seed,setEnforcement:(enabled:boolean)=>{flags.user_model_token_quotas=enabled;},setCatalog:(enabled:boolean)=>{flags.model_catalog=enabled;},
            legacyAfter:async()=>(await pool!.query('SELECT to_jsonb(receipt)-$2::text[] AS row FROM model_usage_calls receipt WHERE id=$1',[legacyId,quotaColumns])).rows[0].row,
            async request(actor:IAccessActor,path:string,method='GET',body?:unknown,validInternal=true){
                if(!path.startsWith('/api/models/'))throw Error('Only the own quota/model API is exposed by this fixture.');
                const response=await originalFetch(apiUrl+path,{method,headers:{'content-type':'application/json','x-neurocenter-internal':validInternal?token:'invalid-fixture-token',
                    'x-bridge-actor':encodeURIComponent(JSON.stringify(actor))},...(body===undefined?{}:{body:JSON.stringify(body)})});
                return {status:response.status,value:await response.json()};
            },close};
    }catch(error){await close().catch(()=>undefined);throw error;}
}
export type QuotaHttpFixture=Awaited<ReturnType<typeof quotaHttpFixture>>;
