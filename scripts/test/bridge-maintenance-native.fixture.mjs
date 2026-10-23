import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {ownedConnection,admit,root} from './package-publication-rollback.fixture.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const revokedMessage='Мост отключён во время выполнения. Проверьте локальные файлы перед повтором.';
const unused=new Proxy({}, {get:(_target,key)=>{if(typeof key==='symbol'||['then','constructor','beforeApplicationShutdown'].includes(key)||/^on[A-Z]/.test(key))return undefined;return()=>{throw Error('Unexpected unused native dependency: '+String(key));};}});

/** Real compiled Nest/Gateway/DeviceStore and full Catalog SQL, confined to an admitted own UUID database. */
export async function maintenanceFixture(){
    const connection=process.env.BRIDGE_MAINTENANCE_CONNECTION_FILE,candidate=process.env.BRIDGE_MAINTENANCE_CANDIDATE,out=process.env.BRIDGE_MAINTENANCE_OUTPUT;
    assert.ok(candidate&&path.isAbsolute(candidate));assert.ok(out&&path.resolve(out).startsWith(path.join(root,'.run/bridge-maintenance-20261023')+path.sep));
    await admit(connection);const admitted=await ownedConnection(connection);await mkdir(out,{recursive:true});
    const require=createRequire(path.join(candidate,'services/catalog-service/package.json'));
    const {Pool}=require('pg');require('reflect-metadata');const {Module}=require('@nestjs/common'),{NestFactory}=require('@nestjs/core');
    const artifacts={};
    const inputFiles=['bridge-dist/context.cjs','bridge-dist/install.sh','mcp/neurocenter-asset-sync/src/bridge/worker-upgrade.ts','mcp/neurocenter-asset-sync/src/bridge/state.ts','mcp/neurocenter-asset-sync/src/bridge/protocol.ts','mcp/neurocenter-asset-sync/src/bridge/read-bounded.ts','mcp/neurocenter-asset-sync/src/bridge/atomic-file.ts','mcp/neurocenter-asset-sync/src/features/opencode-providers/contract.ts','services/shared/opencode-providers.cjs','services/catalog-service/src/devices/device-store.ts','services/catalog-service/src/devices/device.controller.ts','services/catalog-service/src/devices/device-jobs.ts','services/catalog-service/src/access/access-db.ts','services/api-gateway/src/proxy/proxy.service.ts','services/api-gateway/src/proxy/proxy.controller.ts','services/api-gateway/src/auth/auth-guard.service.ts','scripts/test/bridge-installer-lifecycle.fixture.mjs','scripts/test/bridge-maintenance-native.fixture.mjs','scripts/test/bridge-maintenance-native.test.mjs'];
    const hashes=async()=>Object.fromEntries(await Promise.all(inputFiles.map(async file=>[file,sha(await readFile(path.join(root,file)))])));
    const inputsBefore=await hashes();
    const candidateSourceInputs=inputFiles.filter(file=>/^(services|mcp)\//.test(file));
    for(const file of candidateSourceInputs)assert.equal(sha(await readFile(path.join(candidate,file))),inputsBefore[file],'Candidate/current native input '+file);
    for(const pkg of ['catalog-service','api-gateway']){
        const manifest=JSON.parse(await readFile(path.join(candidate,'..',pkg+'-artifacts.json'),'utf8'));
        for(const [file,expected]of Object.entries(manifest.files))assert.equal(sha(await readFile(path.join(candidate,'services',pkg,'dist',file))),expected,'Frozen compiled artifact '+pkg+'/'+file);
        artifacts[pkg]={files:Object.keys(manifest.files).length,manifestSha256:sha(await readFile(path.join(candidate,'..',pkg+'-artifacts.json')))};
    }
    const load=file=>require(path.join(candidate,'services/catalog-service/dist',file));
    const gateway=file=>require(path.join(candidate,'services/api-gateway/dist',file));
    const original={...process.env},name='nc_bridge_maintenance_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:admitted.url.href,max:1,connectionTimeoutMillis:3000});
    let before;
    const receipt={startedAt:new Date().toISOString(),candidate,ownerNonce:admitted.owner.nonce,adminPort:admitted.owner.port,database:name,artifacts,inputsBefore,cases:[],http:[],limits:['Native macOS/arm64; Linux procfs and Windows are separate acceptance.','Actual Bash/context, own idle process and actual worker-upgrade; CLI connect acknowledgement is controlled, not real browser pairing.','Full Catalog schema, actual compiled Nest controllers/AuthGuard/ProxyService/DeviceStore/AccessDb/DeviceJobs; unrelated DI dependencies throw if called.','No production, existing user bridge, Docker, Ceph or external IdP touched.']};
    let created=false,pool,observer,access,store,catalogApp,gatewayApp;
    receipt.candidateSourceInputs=candidateSourceInputs;
    const sockets=new Set(),control={dropPauseAck:false,pauseAckDrops:[],artifact:undefined};
    const close=async()=>{
        const errors=[];
        for(const cleanup of [()=>gatewayApp?.close(),()=>catalogApp?.close(),()=>!catalogApp&&store?.onModuleDestroy(),()=>access?.onModuleDestroy(),()=>pool?.end(),()=>observer?.end()])try{await cleanup();}catch(error){errors.push({name:error.name,message:error.message});}
        for(const socket of sockets)socket.destroy();
        if(created)try{await admin.query('DROP DATABASE "'+name+'"');receipt.ownDatabaseDropped=true;}catch(error){errors.push({resource:'own database',message:error.message});}
        if(before)try{receipt.originalDatabasesPreserved=JSON.stringify(before)===JSON.stringify((await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows);}catch(error){errors.push({resource:'inventory',message:error.message});}
        try{receipt.inputsAfter=await hashes();receipt.sourceStable=JSON.stringify(receipt.inputsBefore)===JSON.stringify(receipt.inputsAfter);if(!receipt.sourceStable)errors.push({resource:'source changed'});}catch(error){errors.push({resource:'source proof',message:error.message});}
        try{for(const pkg of ['catalog-service','api-gateway']){const manifest=JSON.parse(await readFile(path.join(candidate,'..',pkg+'-artifacts.json'),'utf8'));for(const[file,expected]of Object.entries(manifest.files))assert.equal(sha(await readFile(path.join(candidate,'services',pkg,'dist',file))),expected);}receipt.compiledArtifactsStable=true;}catch(error){errors.push({resource:'compiled artifact proof',message:error.message});}
        try{await admin.end();}catch(error){errors.push({resource:'admin pool close',message:error.message});}
        for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);
        receipt.cleanupErrors=errors;receipt.finishedAt=new Date().toISOString();await writeFile(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');return receipt;
    };
    try{
        before=(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
        await admin.query('CREATE DATABASE "'+name+'"');created=true;const url=new URL(admitted.url);url.pathname='/'+name;
        Object.assign(process.env,{CATALOG_PG_URL:url.href,NODE_ENV:'production',SSO_DISABLE:'false',NEUROCENTER_INTERNAL_TOKEN:randomBytes(24).toString('hex'),CAPACITY_REQUIRED:'false'});
        pool=new Pool({connectionString:url.href,max:6,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'owned-bridge-maintenance-control'});
        observer=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:3000,statement_timeout:5000,application_name:'owned-bridge-maintenance-observer'});
        await load('database/catalog-schema.js').ensureCatalogSchema(pool);
        access=new(load('access/access-db.js').AccessDb)();await access.ready();store=new(load('devices/device-store.js').DeviceStore)(access);await store.ready();
        const jobs=new(load('devices/device-jobs.js').DeviceJobs)(store,unused,unused,unused,unused),DeviceController=load('devices/device.controller.js').DeviceController;
        class CatalogModule{}Module({controllers:[DeviceController],providers:[
            {provide:load('devices/device-store.js').DeviceStore,useValue:store},{provide:load('devices/device-jobs.js').DeviceJobs,useValue:jobs},
            {provide:load('devices/device-installations.js').DeviceInstallations,useValue:unused},{provide:load('runtime-artifacts/runtime-artifacts.js').RuntimeArtifacts,useValue:unused},
            {provide:load('models/device-embedding.service.js').DeviceEmbeddingService,useValue:unused},
        ]})(CatalogModule);
        catalogApp=await NestFactory.create(CatalogModule,{logger:false,abortOnError:false});
        catalogApp.use((req,res,next)=>{res.once('finish',()=>receipt.http.push({service:'catalog',method:req.method,path:req.path,status:res.statusCode,authorized:!!req.headers.authorization}));next();});
        await catalogApp.listen(0,'127.0.0.1');const catalogUrl=await catalogApp.getUrl();
        const {AuthGuardService}=gateway('auth/auth-guard.service.js'),{ProxyService}=gateway('proxy/proxy.service.js'),{ProxyController}=gateway('proxy/proxy.controller.js');
        const values={CATALOG_SERVICE_URL:catalogUrl,AUTH_SERVICE_URL:catalogUrl,FEATURE_FLAGS_SERVICE_URL:catalogUrl},config={get:key=>values[key]};
        const proxy=new ProxyService(config,new AuthGuardService(config),{bridge(){throw Error('Maintenance must not publish privileged live events');},sections(){throw Error('Unexpected live section mutation');}});
        class GatewayModule{}Module({controllers:[ProxyController],providers:[{provide:ProxyService,useValue:proxy}]})(GatewayModule);
        gatewayApp=await NestFactory.create(GatewayModule,{logger:false,abortOnError:false});
        gatewayApp.use((req,res,next)=>{
            res.once('finish',()=>receipt.http.push({service:'gateway',method:req.method,path:req.path,status:res.statusCode,authorized:!!req.headers.authorization}));
            if(control.dropPauseAck&&req.path==='/api/device-channel/worker/pause'){
                const end=res.end;res.end=function(...args){
                    let body;try{body=JSON.parse(String(args[0]));}catch{}
                    if(res.statusCode===201&&body?.activeJobs===0){control.dropPauseAck=false;control.pauseAckDrops.push({status:res.statusCode,activeJobs:body.activeJobs});res.destroy();return res;}
                    return end.apply(this,args);
                };
            }
            if(req.method==='GET'&&control.artifact&&req.path.startsWith('/api/bridge/runtime/')){
                const filename=`neurocenter-asset-sync-${process.platform}-${process.arch}-${control.artifact.version}.tgz`;
                if(req.path==='/api/bridge/runtime/'+filename){res.setHeader('content-type','application/gzip');res.end(control.artifact.bytes);return;}
                if(req.path==='/api/bridge/runtime/'+filename+'.sha256'){res.end(sha(control.artifact.bytes)+'\n');return;}
                res.status(404).end();return;
            }
            next();
        });
        await gatewayApp.listen(0,'127.0.0.1');const origin=await gatewayApp.getUrl();
        for(const app of [catalogApp,gatewayApp])app.getHttpServer().on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
        const post=async(route,token,body={})=>{const response=await fetch(origin+'/api/device-channel/'+route,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return{status:response.status,body:await response.json()};};
        const device=async({revoked=true,expired=false,roleLost=false}={})=>{
            const id=randomUUID(),token=randomBytes(32).toString('hex'),email=id+'@bridge.test',role='Главный админ';
            await pool.query('INSERT INTO platform_users(email,display_name,is_main_admin) VALUES($1,$1,$2)',[email,!roleLost]);
            await pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,revoked,expires_at) VALUES($1,$2,$3,'Owned bridge','owned-fingerprint',$4,$5,now()+($6::int*interval '1 day'))",[id,email,role,sha(token),revoked,expired?-1:1]);
            return{id,email,role,token,report:{},revoked};
        };
        const job=async(d,state,message='',result=null)=>{
            const id=randomUUID();await pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,kind,payload,request_key,request_hash,state,message,result,lease_until) VALUES($1,$2,$3,$4,'install','{}',$1,'owned-hash',$5,$6,$7,now()+interval '5 minutes')",[id,d.id,d.email,d.role,state,message,result]);return id;
        };
        const waitQuery=async(pattern)=>{
            const until=Date.now()+5000;
            for(;;){const rows=(await observer.query("SELECT pid,query,wait_event_type FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")).rows;if(rows.some(row=>pattern.test(row.query)))return rows.filter(row=>pattern.test(row.query)).map(row=>({pid:row.pid,query:row.query,wait:row.wait_event_type}));assert.ok(Date.now()<until,'Expected actual row-lock barrier was not reached: '+pattern);await new Promise(resolve=>setTimeout(resolve,10));}
        };
        return{receipt,origin,pool,observer,store,jobs,post,device,job,waitQuery,control,close};
    }catch(error){receipt.initializationError={name:error.name,message:error.message};await close();throw error;}
}
