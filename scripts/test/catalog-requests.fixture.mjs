import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const requireCatalog=createRequire(path.join(root,'services/catalog-service/package.json'));
const requireGateway=createRequire(path.join(root,'services/api-gateway/package.json'));
const actors={
 owner:{email:'owner@requests.example.test',role:'Разработчик'},
 other:{email:'other@requests.example.test',role:'Разработчик'},
 reviewer:{email:'reviewer@requests.example.test',role:'Админ проекта'},
 foreign:{email:'foreign@requests.example.test',role:'Админ проекта'},
 viewer:{email:'viewer@requests.example.test',role:'Наблюдатель'},
 main:{email:'main@requests.example.test',role:'Главный админ'},
 mainAsDeveloper:{email:'main@requests.example.test',role:'Разработчик'},
};
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;};
const closeServer=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};

/** Uses only a caller-identified disposable PostgreSQL instance, never the developer's port5432. */
export async function startCatalogRequestsFixture({adminUrl,browser=false}={}){
 const admin=new URL(adminUrl);assert.ok(['127.0.0.1','localhost'].includes(admin.hostname));
 assert.ok(admin.port&&admin.port!=='5432','Use the separate disposable PostgreSQL container.');assert.equal(admin.pathname,'/postgres');
 const environment={...process.env},temporary=await fs.mkdtemp(path.join(os.tmpdir(),'nc-requests-http-'));
 const run=randomUUID().replaceAll('-','').slice(0,12),database='nc_request_http_'+run,cookieName='nc_requests_qa_'+run;
 const {Pool}=requireCatalog('pg');
 const adminPool=new Pool({connectionString:admin.href,max:1}),url=new URL(admin);url.pathname='/'+database;
 const pool=new Pool({connectionString:url.href,max:4});
 let access,catalog,gateway,upstream,io,vite,created=false;
 const state={authAvailable:true,skillsAvailable:true,skillPresent:true,requests:[],dependencyRequests:[]};
 const ids={projectA:'prj-qa-requests-a',projectB:'prj-qa-requests-b',plugin:'ai-plug-'+randomUUID(),mcp:'ai-plug-'+randomUUID(),model:'model-qa-requests',skill:'common/qa-requests-skill',device:randomUUID()};
 const deviceToken=randomBytes(32).toString('hex');
 const skills=()=>state.skillPresent?[{path:ids.skill,slug:'qa-requests-skill',name:'QA Requests Skill',body:'A fixture instruction.',meta:{name:'QA Requests Skill',version:1,description:'Isolated instruction'}}]:[];
 const selected=req=>{
  const value=String(req.headers.cookie||'').split(';').map(item=>item.trim()).find(item=>item.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  return actors[value]?value:null;
 };
 const cookie=actor=>{assert.ok(actors[actor]);return cookieName+'='+actor;};
 async function close(){
  const failures=[];
  const finish=async(work)=>{try{await work();}catch(error){failures.push(error);}};
  if(vite)await finish(()=>vite.close());
  if(io)await finish(()=>new Promise(resolve=>io.close(resolve)));
  if(gateway)await finish(()=>gateway.close());
  if(catalog)await finish(()=>catalog.close());
  if(upstream)await finish(()=>closeServer(upstream));
  await finish(()=>pool.end());
  if(created)await finish(()=>adminPool.query('DROP DATABASE '+database+' WITH (FORCE)'));
  await finish(()=>adminPool.end());
  for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];
  Object.assign(process.env,environment);
  await finish(()=>fs.rm(temporary,{recursive:true,force:true}));
  if(failures.length)throw new AggregateError(failures,'Isolated fixture cleanup failed.');
 }
 try{
  await adminPool.query('CREATE DATABASE '+database);created=true;
  for(const key of Object.keys(process.env))if(key.endsWith('_FILE')||key.startsWith('SNAPSHOT_'))delete process.env[key];
  Object.assign(process.env,{
   NODE_ENV:'test',CATALOG_PG_URL:url.href,RAG_PG_URL:url.href,RAG_PROVISION_PG_URL:url.href,
   NEUROCENTER_INTERNAL_TOKEN:randomBytes(32).toString('hex'),SSO_DISABLE:'true',DEV_USER_EMAIL:actors.main.email,
   NEUROCENTER_MODEL_CREDENTIAL_KEY:randomBytes(32).toString('hex'),
   PROJECTS_ROOT:path.join(temporary,'projects'),RUNTIME_ARTIFACT_DIR:path.join(temporary,'runtime'),
   SKILLS_STORAGE_PATH:path.join(temporary,'skills'),BACKUP_DIR:path.join(temporary,'backups'),MODEL_STORAGE_PATH:path.join(temporary,'models'),
   ASSET_SYNC_MCP_BIN:path.join(temporary,'no-bridge-runtime.js'),BIND_HOST:'127.0.0.1',
  });
  for(const directory of ['projects','runtime','skills','backups','models'])await fs.mkdir(path.join(temporary,directory),{recursive:true});
  upstream=http.createServer(async(req,res)=>{
   try{
    const route=new URL(req.url,'http://fixture');state.dependencyRequests.push({method:req.method,path:route.pathname});
    if(route.pathname.startsWith('/__qa/role/')){
     const actor=route.pathname.split('/').at(-1);if(!actors[actor])return json(res,404,{message:'Unknown fixture actor.'});
     res.writeHead(302,{'set-cookie':cookie(actor)+'; HttpOnly; SameSite=Lax; Path=/',location:'/store?tab=requests'});res.end();return;
    }
    if(route.pathname==='/auth/me'){
     if(!state.authAvailable)return json(res,503,{message:'Fixture auth outage.'});
     const key=selected(req);if(!key)return json(res,401,{message:'Fixture login required.'});
     const actor=actors[key],claims=await access.claims(actor.email);
     if(!claims.userRoles.includes(actor.role))return json(res,403,{message:'Fixture role revoked.'});
     return json(res,200,{user:{id:actor.email,principalName:actor.email,email:actor.email,displayName:key,activeRole:actor.role,userRoles:claims.userRoles,projectRoles:claims.projects,
      routePermissions:['start','store','projects','rag','maintenance','audit','access','assets']},policies:{}});
    }
    if(route.pathname==='/auth/login'){
     res.writeHead(302,{'set-cookie':cookie('owner')+'; HttpOnly; SameSite=Lax; Path=/',location:'/store?tab=requests'});res.end();return;
    }
    if(route.pathname==='/api/skills')return json(res,state.skillsAvailable?200:503,state.skillsAvailable?skills():{message:'Fixture skills outage.'});
    if(route.pathname==='/api/feature-flags/evaluated'||route.pathname==='/internal/feature-flags/evaluated')return json(res,200,{flags:{tool_builds:true,model_hosting:true,rag_sync:true}});
    if(route.pathname==='/ready'||route.pathname==='/health')return json(res,200,{ok:true});
    return json(res,404,{message:'Unsupported fixture dependency.'});
   }catch{return json(res,403,{message:'Fixture identity is unavailable.'});}
  });
  const upstreamUrl=await listen(upstream);
  for(const name of ['AUTH_SERVICE_URL','SKILLS_SERVICE_URL','RAG_SERVICE_URL','FEATURE_FLAGS_SERVICE_URL','MODEL_RUNTIME_URL'])process.env[name]=upstreamUrl;
  requireCatalog('ts-node').register({transpileOnly:true,project:path.join(root,'services/catalog-service/tsconfig.json')});
  requireCatalog('reflect-metadata');
  const {NestFactory}=requireCatalog('@nestjs/core');
  const {AppModule}=requireCatalog('./src/app.module.ts');
  const {AccessDb}=requireCatalog('./src/access/access-db.ts');
  const express=requireCatalog('express');
  catalog=await NestFactory.create(AppModule,{logger:false,bodyParser:false,abortOnError:false});
  catalog.use(express.json({limit:'2mb'}));
  catalog.use((req,res,next)=>{
   if(req.path.startsWith('/api/')&&req.headers['x-neurocenter-internal']!==process.env.NEUROCENTER_INTERNAL_TOKEN)return json(res,403,{message:'Fixture requires actual Gateway forwarding.'});
   next();
  });
  await catalog.listen(0,'127.0.0.1');access=catalog.get(AccessDb);
  const catalogUrl='http://127.0.0.1:'+catalog.getHttpServer().address().port;process.env.CATALOG_SERVICE_URL=catalogUrl;
  for(const actor of Object.values(actors))await pool.query('INSERT INTO platform_users(email,display_name,is_main_admin) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET is_main_admin=EXCLUDED.is_main_admin,enabled=true',[actor.email,actor.email,actor.email===actors.main.email]);
  for(const [id,name]of [[ids.projectA,'QA Requests Alpha'],[ids.projectB,'QA Requests Beta']])await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)',[id,name]);
  for(const [actor,project,role]of [['owner',ids.projectA,'Разработчик'],['other',ids.projectA,'Разработчик'],['reviewer',ids.projectA,'Админ проекта'],['reviewer',ids.projectB,'Разработчик'],['foreign',ids.projectB,'Админ проекта'],['viewer',ids.projectA,'Наблюдатель'],['mainAsDeveloper',ids.projectA,'Разработчик']])
   await pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)',[project,actors[actor].email,role]);
  for(const [type,id,name]of [['plugin',ids.plugin,'QA Requests Plugin'],['mcp',ids.mcp,'QA Requests MCP']]){
   await pool.query('INSERT INTO ai_plugins(id,name,kind) VALUES($1,$2,$3)',[id,name,type]);
   await pool.query('INSERT INTO project_assets(project_id,asset_id,asset_kind) VALUES($1,$2,$3)',[ids.projectA,id,type]);
  }
  await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3)',[ids.model,'QA Requests Model',JSON.stringify({description:'Isolated remote model',capability:'embedding',runtime:'remote-openai',model:'qa-embedding',manifestSha256:null,dimension:3,source:'custom',modelVersion:'fixture'})]);
  await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)',[ids.projectA,ids.model,actors.main.email]);
  await pool.query('INSERT INTO project_assets(project_id,asset_id,asset_kind) VALUES($1,$2,$3)',[ids.projectA,ids.skill,'skill']);
  await pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES($1,$2,$3,$4,$5,$6)',[ids.device,actors.owner.email,'Разработчик','QA requests device',run,createHash('sha256').update(deviceToken).digest('hex')]);
  const {Module}=requireGateway('@nestjs/common'),{NestFactory:GatewayFactory}=requireGateway('@nestjs/core');
  const {ProxyService}=requireGateway('./dist/proxy/proxy.service.js'),{ProxyController}=requireGateway('./dist/proxy/proxy.controller.js');
  const {AuthGuardService}=requireGateway('./dist/auth/auth-guard.service.js'),{browserSecurity}=requireGateway('./dist/security/browser-security.js');
  const {setupApiDocumentation}=requireGateway('./dist/docs/setup-api-documentation.js');
  const config={get:key=>process.env[key]},auth=new AuthGuardService(config);
  const proxy=new ProxyService(config,auth,{mutation(){}});
  class GatewayFixtureModule{};
  Module({controllers:[ProxyController],providers:[{provide:ProxyService,useValue:proxy}]})(GatewayFixtureModule);
  gateway=await GatewayFactory.create(GatewayFixtureModule,{logger:false,abortOnError:false});
  gateway.use((req,_res,next)=>{state.requests.push({method:req.method,path:req.path,csrf:req.headers['x-neurocenter-request']});next();});
  gateway.use(browserSecurity);setupApiDocumentation(gateway,auth);
  const {Server}=requireGateway('socket.io');io=new Server(gateway.getHttpServer(),{cors:{origin:(_origin,done)=>done(null,true),credentials:true}});
  io.use(async(socket,next)=>{try{if(await auth.authenticate(socket.request))return next();}catch{}next(Error('Fixture login required.'));});
  await gateway.listen(0,'127.0.0.1');
  const gatewayUrl='http://127.0.0.1:'+gateway.getHttpServer().address().port;process.env.PANEL_URL=gatewayUrl;
  let base=gatewayUrl;
  if(browser){
   const {createServer}=await import(pathToFileURL(requireCatalog.resolve('../../frontend/node_modules/vite/dist/node/index.js')).href);
   const frontend=path.join(root,'frontend');
   const probe=http.createServer();await listen(probe);const port=probe.address().port;await closeServer(probe);
   vite=await createServer({root:frontend,configFile:path.join(frontend,'vite.config.ts'),envFile:false,mode:'development',cacheDir:path.join(temporary,'vite-cache'),
    define:{'process.env.NODE_ENV':JSON.stringify('development')},optimizeDeps:{esbuildOptions:{define:{'process.env.NODE_ENV':JSON.stringify('development')}}},
    server:{host:'127.0.0.1',port,strictPort:true,
    proxy:{'/api':{target:gatewayUrl,changeOrigin:true},'/auth':{target:upstreamUrl,changeOrigin:true},'/__qa':{target:upstreamUrl,changeOrigin:true},'/socket.io':{target:gatewayUrl,ws:true}}}});
   await vite.listen();base='http://127.0.0.1:'+vite.httpServer.address().port;process.env.PANEL_URL=base;
  }
  return {base,gatewayUrl,catalogUrl,ids,actors,state,pool,cookie,database,temporary,close,deviceToken,sourceProbeUrl:upstreamUrl+'/never-download-source',
   loginUrl:actor=>base+'/__qa/role/'+actor,
   async request(actor,route,{method='GET',body,status=200,headers={}}={}){
    const response=await fetch(gatewayUrl+route,{method,headers:{'content-type':'application/json','x-neurocenter-request':'1',origin:base,...(actor?{cookie:cookie(actor)}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(15000)});
    const raw=await response.text();let value;try{value=raw?JSON.parse(raw):null;}catch{value=raw;}
    assert.equal(response.status,status,method+' '+route+': '+JSON.stringify(value));return value;
   }};
 }catch(error){try{await close();}catch(cleanupError){throw Object.assign(new AggregateError([error,cleanupError],'Fixture startup and cleanup failed.'),{fixtureCleanupFailed:true});}throw error;}
}
