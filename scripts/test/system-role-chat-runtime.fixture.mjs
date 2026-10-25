import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const requireCatalog=createRequire(path.join(root,'services/catalog-service/package.json'));
const actorEmail={owner:'owner@service-runtime.test',other:'other@service-runtime.test'};
const ledgers=['system_role_runs','system_role_dialog_intents','system_role_mcp_sessions','system_role_mcp_calls',
    'model_usage_calls','device_model_calls','model_hosting_jobs','bridge_jobs','tool_build_jobs'];
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
const deadline=async(promise,milliseconds,message)=>{
    let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),milliseconds);})]);}
    finally{clearTimeout(timer);}
};

/** Actual AppModule and SQL. The optional fault hook runs only after real Nest shutdown. */
export async function startSystemRoleChatRuntime(adminConnection,{afterApplicationClose,syntheticChatCompletions}={}){
    const adminUrl=ownedTestPostgresAdmin(adminConnection);
    const pg=requireCatalog('pg'),NativePool=pg.Pool;
    const environment={...process.env},previousCwd=process.cwd(),nativeFetch=globalThis.fetch;
    const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'nc-service-chat-runtime-'));
    const database='nc_service_chat_runtime_'+randomUUID().replaceAll('-','');
    assert.match(database,/^nc_service_chat_runtime_[a-f0-9]{32}$/);
    const url=new URL(adminUrl);url.pathname='/'+database;
    const admin=new NativePool({connectionString:adminUrl.href,max:1,connectionTimeoutMillis:3000});
    let inspection,app,upstream,registration,created=false,poolGuardInstalled=false,closing;
    const productPools=new Set(),activeDependencies=new Set();
    const state={dependencyCalls:[],eventStatus:200,unknownDependencies:0,blockedFetches:0,blockedPools:0,cleanup:null};
    const {defaultFeatureFlags,evaluateFeatureFlags}=requireCatalog(path.join(root,'services/shared/feature-flags.cjs'));
    state.flags=defaultFeatureFlags();
    const token=randomBytes(32).toString('hex'),project='prj-service-runtime';
    let origin,base;

    async function productClients(){
        return Number((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[database])).rows[0].n);
    }
    async function close(){
        if(closing)return closing;
        closing=(async()=>{
            const failures=[],errors=[];let applicationClosed=false;
            const failed=(label,error)=>{failures.push(label);errors.push(error);};
            const finish=async(label,work)=>{try{await deadline(Promise.resolve().then(work),15000,label+' cleanup timed out');}catch(error){failed(label,error);}};
            let clientsAfterApplicationClose=null;
            try{
                if(app)await finish('catalog application',async()=>{await app.close();applicationClosed=true;await afterApplicationClose?.();});
                if(created)await finish('application client check',async()=>{
                    // The inspection connection is closed before this authoritative check.
                    await inspection?.end();inspection=undefined;
                    clientsAfterApplicationClose=await productClients();
                    assert.equal(clientsAfterApplicationClose,0,'Catalog shutdown left its PostgreSQL clients connected');
                });
                // Emergency cleanup never turns a failed lifecycle assertion into a passing acceptance result.
                if(failures.length)await finish('owned product pools',()=>Promise.allSettled([...productPools].map(pool=>pool.end())).then(results=>{
                    if(results.some(result=>result.status==='rejected'&&!/end.*more than once/i.test(String(result.reason))))throw Error('Owned pools did not close');
                }));
                if(upstream)await finish('synthetic HTTP peer',async()=>{
                    upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
                    await Promise.allSettled([...activeDependencies]);
                });
                if(created)await finish('owned database',async()=>{
                    assert.equal(await productClients(),0,'Owned database still has connected clients');
                    await admin.query('DROP DATABASE '+database);created=false;
                });
                await finish('admin pool',()=>admin.end());
                if(!failures.length)await finish('temporary directory',()=>fs.rm(temporary,{recursive:true,force:true}));
            }finally{
                const restore=[
                    ['PostgreSQL constructor',()=>{if(poolGuardInstalled)pg.Pool=NativePool;}],
                    ['source loader',()=>registration?.enabled(false)],
                    ['HTTP transport',()=>{globalThis.fetch=nativeFetch;}],
                    ['working directory',()=>process.chdir(previousCwd)],
                    ['process environment',()=>{
                        for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];
                        Object.assign(process.env,environment);
                    }],
                ];
                for(const[label,work]of restore)try{work();}catch(error){failed(label,error);}
            }
            state.cleanup={applicationClosed,clientsAfterApplicationClose,databaseDropped:!created,failures};
            if(failures.length){
                state.cleanup.diagnosticPath=path.join(temporary,'cleanup-error.json');
                await finish('cleanup diagnostic',()=>fs.writeFile(state.cleanup.diagnosticPath,JSON.stringify({...state.cleanup,
                    errors:errors.map((error,index)=>({phase:failures[index],name:error?.name??'Unknown',code:error?.code??null}))},null,2)+'\n',{mode:0o600}));
                throw new AggregateError(errors,'Owned runtime cleanup failed: '+failures.join(', '));
            }
            return state.cleanup;
        })();
        return closing;
    }

    try{
        assert.equal(Number((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1',[database])).rows[0].n),0);
        await admin.query('CREATE DATABASE '+database);created=true;
        inspection=new NativePool({connectionString:url.href,max:1,connectionTimeoutMillis:3000});
        for(const key of Object.keys(process.env))if(/(?:_URL|_FILE|_DIR|_PATH|_ROOT|_CONFIG|_KEY|_TOKEN|_SECRET|_PASSWORD)$|^(?:PG[A-Z]|SNAPSHOT_|CHAT_S3_|MINIO_|NODE_OPTIONS$|TS_NODE_|ASSET_SOURCE_)/.test(key))delete process.env[key];
        for(const directory of ['projects','runtime','skills','backups','models'])await fs.mkdir(path.join(temporary,directory),{mode:0o700});
        Object.assign(process.env,{
            NODE_ENV:'test',SSO_DISABLE:'true',DEV_USER_EMAIL:'main@service-runtime.test',
            CATALOG_PG_URL:url.href,RAG_PG_URL:url.href,RAG_PROVISION_PG_URL:url.href,
            NEUROCENTER_INTERNAL_TOKEN:token,NEUROCENTER_MODEL_CREDENTIAL_KEY:randomBytes(32).toString('base64'),
            ASSET_SOURCE_MODE:'offline',MODEL_HOSTING_ENABLED:'false',
            PROJECTS_ROOT:path.join(temporary,'projects'),RUNTIME_ARTIFACT_DIR:path.join(temporary,'runtime'),
            SKILLS_STORAGE_PATH:path.join(temporary,'skills'),BACKUP_DIR:path.join(temporary,'backups'),MODEL_STORAGE_PATH:path.join(temporary,'models'),
            ASSET_SYNC_MCP_BIN:path.join(temporary,'absent-bridge.js'),BIND_HOST:'127.0.0.1',
        });
        process.chdir(temporary);
        await assert.rejects(fs.stat(path.join(temporary,'.env')),{code:'ENOENT'});
        upstream=http.createServer((req,res)=>{
            const pending=(async()=>{
                const route=new URL(req.url,'http://fixture').pathname;
                state.dependencyCalls.push({method:req.method,path:route});
                if(route==='/v1/chat/completions'&&syntheticChatCompletions)return syntheticChatCompletions(req,res);
                if(route==='/internal/feature-flags/evaluated'){
                    if(req.headers['x-neurocenter-internal']!==token)return json(res,403,{message:'Fixture token required'});
                    return json(res,200,evaluateFeatureFlags(state.flags));
                }
                if(route==='/internal/events'){for await(const _chunk of req){}return json(res,state.eventStatus,{accepted:state.eventStatus===200});}
                if(route==='/api/skills')return json(res,200,[]);
                if(route==='/auth/me')return json(res,503,{message:'No external identity provider in this fixture'});
                if(route==='/ready'||route==='/health')return json(res,200,{ok:true});
                state.unknownDependencies++;return json(res,451,{message:'Dependency action is outside this fixture'});
            })().catch(()=>{if(!res.headersSent)json(res,503,{message:'Fixture dependency failed'});else res.destroy();})
                .finally(()=>activeDependencies.delete(pending));
            activeDependencies.add(pending);
        });
        upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
        origin='http://127.0.0.1:'+upstream.address().port;
        for(const name of ['AUTH_SERVICE_URL','SKILLS_SERVICE_URL','RAG_SERVICE_URL','FEATURE_FLAGS_SERVICE_URL','MODEL_RUNTIME_URL','API_GATEWAY_URL','CATALOG_SERVICE_URL'])process.env[name]=origin;
        globalThis.fetch=(input,options)=>{
            const target=new URL(typeof input==='string'||input instanceof URL?input:input.url);
            if(target.origin!==origin&&target.origin!==base){state.blockedFetches++;throw new Error('Outbound HTTP is outside the owned runtime fixture');}
            return nativeFetch(input,options);
        };
        // Guard constructor identity, not SQL: every actual product Pool must target this newly created database.
        pg.Pool=class OwnedRuntimePool extends NativePool{
            constructor(config){
                if(config?.connectionString!==url.href){state.blockedPools++;throw new Error('Product PostgreSQL target is outside the owned runtime database');}
                super(config);productPools.add(this);
            }
        };poolGuardInstalled=true;
        registration=requireCatalog('ts-node').register({transpileOnly:true,project:path.join(root,'services/catalog-service/tsconfig.json')});
        requireCatalog('reflect-metadata');
        const {NestFactory}=requireCatalog('@nestjs/core'),express=requireCatalog('express');
        const {AppModule}=requireCatalog(path.join(root,'services/catalog-service/src/app.module.ts'));
        app=await NestFactory.create(AppModule,{logger:false,bodyParser:false,abortOnError:false});
        app.use(express.json({limit:'2mb'}));
        app.use((req,res,next)=>{
            if(req.path.startsWith('/api/')&&req.headers['x-neurocenter-internal']!==token)return res.status(403).json({message:'Fixture requires the trusted gateway boundary'});
            next();
        });
        await deadline(app.listen(0,'127.0.0.1'),85000,'Canonical Catalog startup did not finish');
        base='http://127.0.0.1:'+app.getHttpServer().address().port;
        await inspection.query('INSERT INTO projects(id,name) VALUES($1,$2)',[project,'Service runtime fixture']);
        for(const email of Object.values(actorEmail)){
            await inspection.query('INSERT INTO platform_users(email) VALUES($1)',[email]);
            await inspection.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,'Админ проекта')",[project,email]);
        }
        const {checkCatalogSchema}=requireCatalog(path.join(root,'services/catalog-service/src/database/catalog-schema.ts'));
        return {app,state,project,database,temporary,actors:actorEmail,pool:inspection,close,productPoolCount:()=>productPools.size,
            schema:()=>checkCatalogSchema(inspection,true),
            ledgerCounts:async()=>Object.fromEntries(await Promise.all(ledgers.map(async table=>[table,Number((await inspection.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n)]))),
            async request(actor,route,{method='GET',body,status=200,role='Админ проекта',trusted=true}={}){
                const response=await nativeFetch(base+route,{method,redirect:'error',signal:AbortSignal.timeout(12000),headers:{'content-type':'application/json',
                    ...(trusted?{'x-neurocenter-internal':token}:{}),...(actor?{'x-bridge-actor':encodeURIComponent(JSON.stringify({email:actorEmail[actor]??actor,activeRole:role}))}:{})},
                    body:body===undefined?undefined:JSON.stringify(body)});
                const text=await response.text();let value;try{value=text?JSON.parse(text):null;}catch{throw new Error('Catalog returned non-JSON fixture response');}
                assert.equal(response.status,status,method+' '+route+' returned an unexpected HTTP status');return value;
            },
        };
    }catch(error){
        try{await close();}catch(cleanupError){throw new AggregateError([error,cleanupError],'Canonical Catalog startup failed and owned cleanup was incomplete');}
        throw error;
    }
}
