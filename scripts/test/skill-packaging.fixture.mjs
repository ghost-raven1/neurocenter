import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url)),requireCatalog=createRequire(path.join(root,'services/catalog-service/package.json'));
const requireSkills=createRequire(path.join(root,'services/skills-service/package.json'));
const requireGateway=createRequire(path.join(root,'services/api-gateway/package.json'));
const {assetSourceArchiveRoute}=requireCatalog('../shared/asset-source-archive-route.cjs');
const {defaultFeatureFlags,evaluateFeatureFlags}=requireCatalog('../shared/feature-flags.cjs');
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;};
const closeServer=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};

/** Full native services with a disposable PostgreSQL database and private temporary skill/project roots. */
export async function startSkillPackagingFixture({adminUrl:configuredAdminUrl,browser=false,configureCatalog}={}){
 const adminUrl=new URL(configuredAdminUrl);assert.equal(adminUrl.hostname,'127.0.0.1');assert.ok(adminUrl.port&&adminUrl.port!=='5432','Use a caller-identified disposable PostgreSQL instance.');
 assert.equal(adminUrl.pathname,'/postgres');
 const environment={...process.env},originalFetch=globalThis.fetch;
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'nc-skill-packaging-'));
 const run=randomUUID().replaceAll('-',''),database='nc_packaging_'+run,cookieName='nc_packaging_'+run;
 const actors={main:{email:'main@packaging.example.test',role:'Главный админ'},developer:{email:'developer@packaging.example.test',role:'Разработчик'}};
 const {Pool}=requireCatalog('pg'),admin=new Pool({connectionString:adminUrl.href,max:1});
 const url=new URL(adminUrl);url.pathname='/'+database;const pool=new Pool({connectionString:url.href,max:4});
 const state={authAvailable:true,skillsAvailable:true,modelHostingEnabled:true,featureOverrides:{},loseSkillPublishAck:0,externalCalls:[],requests:[],github:new Map()},responseBytes=new WeakMap();
 let catalog,skills,gateway,upstream,vite,io,access,created=false;
 const cookie=key=>{assert.ok(actors[key]);return cookieName+'='+key;};
 const selected=req=>String(req.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith(cookieName+'='))?.slice(cookieName.length+1);
 const close=async()=>{
  const failures=[];const finish=async work=>{try{await work();}catch(error){failures.push(error);}};
  if(vite)await finish(()=>vite.close());if(io)await finish(()=>new Promise(resolve=>io.close(resolve)));
  if(gateway)await finish(()=>gateway.close());if(catalog)await finish(()=>catalog.close());if(skills)await finish(()=>skills.close());
  if(upstream)await finish(()=>closeServer(upstream));await finish(()=>pool.end());
  // pg-pool end() may resolve before client sockets finish closing; normal DROP waits instead of killing them.
  if(created)await finish(()=>admin.query('DROP DATABASE '+database));await finish(()=>admin.end());
  globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);
  await finish(()=>fs.rm(temporary,{recursive:true,force:true}));if(failures.length)throw new AggregateError(failures,'QA cleanup failed.');
 };
 try{
  await admin.query('CREATE DATABASE '+database);created=true;
  for(const key of Object.keys(process.env))if(key.endsWith('_FILE')||key.startsWith('SNAPSHOT_'))delete process.env[key];
  Object.assign(process.env,{NODE_ENV:'production',CATALOG_PG_URL:url.href,RAG_PG_URL:url.href,RAG_PROVISION_PG_URL:url.href,
   NEUROCENTER_INTERNAL_TOKEN:randomBytes(32).toString('hex'),NEUROCENTER_MODEL_CREDENTIAL_KEY:randomBytes(32).toString('base64'),
   SSO_DISABLE:'true',DEV_USER_EMAIL:actors.main.email,CAPACITY_REQUIRED:'false',BIND_HOST:'127.0.0.1',
   PROJECTS_ROOT:path.join(temporary,'projects'),SKILLS_STORAGE_PATH:path.join(temporary,'skills'),RUNTIME_ARTIFACT_DIR:path.join(temporary,'runtime'),
   BACKUP_DIR:path.join(temporary,'backups'),MODEL_STORAGE_PATH:path.join(temporary,'models'),ASSET_SYNC_MCP_BIN:path.join(temporary,'no-runtime.js')});
  for(const name of ['projects','skills','runtime','backups','models'])await fs.mkdir(path.join(temporary,name),{recursive:true});
  globalThis.fetch=async(input,options)=>{
   const target=String(input instanceof Request?input.url:input),parsed=new URL(target);
   if(!state.skillsAvailable&&parsed.origin===process.env.SKILLS_SERVICE_URL)return Response.json({message:'Synthetic skills outage.'},{status:503});
   if(['api.github.com','raw.githubusercontent.com','codeload.github.com','github.com','registry.npmjs.org'].includes(parsed.hostname)){
    state.externalCalls.push(target);const value=state.github.get(target);
    if(typeof value==='function')return value(input,options);
    if(value instanceof Response){
     // A tee clone can wait forever on cancel while its original branch remains unread.
     if(!responseBytes.has(value))responseBytes.set(value,value.arrayBuffer());
     const bytes=await responseBytes.get(value);
     return new Response([204,205,304].includes(value.status)?null:bytes,{status:value.status,statusText:value.statusText,headers:value.headers});
    }
    if(value!==undefined)return Response.json(value);
    return Response.json({message:'Synthetic source is unavailable.'},{status:503});
   }
   if(!['127.0.0.1','localhost'].includes(parsed.hostname))throw Error('QA forbids external request: '+parsed.hostname);
   const response=await originalFetch(input,options);
   if(state.loseSkillPublishAck>0&&parsed.origin===process.env.SKILLS_SERVICE_URL&&parsed.pathname==='/internal/asset-sources/skills/publish'&&response.ok){
    state.loseSkillPublishAck--;await response.arrayBuffer();throw Error('Synthetic lost acknowledgement after native skill commit.');
   }
   return response;
  };
  upstream=http.createServer(async(req,res)=>{
   try{
    const route=new URL(req.url,'http://fixture');
    if(route.pathname.startsWith('/__qa/role/')){const key=route.pathname.split('/').at(-1);assert.ok(actors[key]);res.writeHead(302,{'set-cookie':cookie(key)+'; HttpOnly; SameSite=Lax; Path=/',location:'/store'});res.end();return;}
    if(route.pathname==='/auth/login'){res.writeHead(302,{'set-cookie':cookie('main')+'; HttpOnly; SameSite=Lax; Path=/',location:'/store'});res.end();return;}
    if(route.pathname==='/auth/me'){
     if(!state.authAvailable)return json(res,503,{message:'Synthetic authentication outage.'});
     const key=selected(req);if(!actors[key])return json(res,401,{message:'QA login required.'});const actor=actors[key],claims=await access.claims(actor.email);
     return json(res,200,{user:{id:actor.email,email:actor.email,principalName:actor.email,displayName:'QA '+key,activeRole:actor.role,userRoles:claims.userRoles,projectRoles:claims.projects,
      routePermissions:['start','store','projects','rag','maintenance','audit','access','assets','model-usage']},policies:{}});
    }
    if(route.pathname.includes('feature-flags')&&route.pathname.endsWith('evaluated'))return json(res,200,evaluateFeatureFlags({...defaultFeatureFlags(),model_hosting:state.modelHostingEnabled,...state.featureOverrides}));
    if(['/ready','/health','/internal/events'].includes(route.pathname))return json(res,200,{ok:true});
    return json(res,404,{message:'Unsupported QA dependency.'});
   }catch(error){return json(res,500,{message:'QA upstream: '+error.message});}
  });
  const upstreamUrl=await listen(upstream);for(const name of ['AUTH_SERVICE_URL','RAG_SERVICE_URL','FEATURE_FLAGS_SERVICE_URL','MODEL_RUNTIME_URL'])process.env[name]=upstreamUrl;
  const {NestFactory}=requireCatalog('@nestjs/core'),express=requireCatalog('express');requireCatalog('reflect-metadata');
  const jsonParser=express.json({limit:'35mb'}),gatewayJsonParser=express.json({limit:'50mb'});
  const middleware=app=>{app.use((req,res,next)=>assetSourceArchiveRoute(req.method,req.originalUrl)?next():jsonParser(req,res,next));app.use((req,res,next)=>{
   if(req.path.startsWith('/api/')&&req.headers['x-neurocenter-internal']!==process.env.NEUROCENTER_INTERNAL_TOKEN)return json(res,403,{message:'Actual Gateway forwarding required.'});next();});};
  skills=await requireSkills('@nestjs/core').NestFactory.create(requireSkills('./dist/app.module.js').AppModule,{logger:false,bodyParser:false,abortOnError:false});middleware(skills);await skills.listen(0,'127.0.0.1');
  const skillsUrl='http://127.0.0.1:'+skills.getHttpServer().address().port;process.env.SKILLS_SERVICE_URL=skillsUrl;
  catalog=await NestFactory.create(requireCatalog('./dist/app.module.js').AppModule,{logger:false,bodyParser:false,abortOnError:false});middleware(catalog);if(configureCatalog)await configureCatalog(catalog);await catalog.listen(0,'127.0.0.1');
  const catalogUrl='http://127.0.0.1:'+catalog.getHttpServer().address().port;process.env.CATALOG_SERVICE_URL=catalogUrl;
  access=catalog.get(requireCatalog('./dist/access/access-db.js').AccessDb);
  for(const [key,actor]of Object.entries(actors))await pool.query('INSERT INTO platform_users(email,display_name,is_main_admin) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET display_name=EXCLUDED.display_name,is_main_admin=EXCLUDED.is_main_admin,enabled=true',[actor.email,'QA '+key,key==='main']);
  const projectId='prj-qa-packaging';await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)',[projectId,'QA Skill Packaging']);
  await pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)',[projectId,actors.developer.email,'Разработчик']);
  const {Module}=requireGateway('@nestjs/common'),{NestFactory:GatewayFactory}=requireGateway('@nestjs/core');
  const {ProxyService}=requireGateway('./dist/proxy/proxy.service.js'),{ProxyController}=requireGateway('./dist/proxy/proxy.controller.js');
  const {AuthGuardService}=requireGateway('./dist/auth/auth-guard.service.js'),{browserSecurity}=requireGateway('./dist/security/browser-security.js');
  const {LiveService}=requireGateway('./dist/live/live.service.js'),{LiveController}=requireGateway('./dist/live/live.controller.js');
  const {BridgeController}=requireGateway('./dist/bridge/bridge.controller.js'),{BridgeSupplyService}=requireGateway('./dist/bridge/bridge-supply.service.js');
  const live=new LiveService(),liveApi={mutation:live.mutation.bind(live),sections:live.sections.bind(live)};
  const config={get:key=>process.env[key]},auth=new AuthGuardService(config),proxy=new ProxyService(config,auth,liveApi);
  class GatewayFixtureModule{}Module({controllers:[BridgeController,ProxyController,LiveController],providers:[{provide:ProxyService,useValue:proxy},{provide:LiveService,useValue:liveApi},{provide:BridgeSupplyService,useValue:new BridgeSupplyService(config)}]})(GatewayFixtureModule);
  gateway=await GatewayFactory.create(GatewayFixtureModule,{logger:false,bodyParser:false,abortOnError:false});gateway.use(browserSecurity);gateway.use((req,res,next)=>assetSourceArchiveRoute(req.method,req.originalUrl)?next():gatewayJsonParser(req,res,next));
  gateway.use((req,_res,next)=>{state.requests.push({method:req.method,path:req.path});next();});
  const {Server}=requireGateway('socket.io');io=new Server(gateway.getHttpServer(),{cors:{origin:(_origin,done)=>done(null,true),credentials:true}});
  live.attach(io);
  io.use(async(socket,next)=>{try{if(await auth.authenticate(socket.request))return next();}catch{}next(Error('QA login required.'));});
  await gateway.listen(0,'127.0.0.1');const gatewayUrl='http://127.0.0.1:'+gateway.getHttpServer().address().port;process.env.API_GATEWAY_URL=gatewayUrl;process.env.API_PUBLIC_URL=gatewayUrl;
  let base=gatewayUrl;process.env.PANEL_URL=base;
  if(browser){
   const {createServer}=await import(pathToFileURL(requireCatalog.resolve('../../frontend/node_modules/vite/dist/node/index.js')).href);
   const probe=http.createServer();await listen(probe);const port=probe.address().port;await closeServer(probe);
   vite=await createServer({root:path.join(root,'frontend'),configFile:path.join(root,'frontend/vite.config.ts'),envFile:false,mode:'development',cacheDir:path.join(temporary,'vite-cache'),
    define:{'process.env.NODE_ENV':JSON.stringify('development')},optimizeDeps:{esbuildOptions:{define:{'process.env.NODE_ENV':JSON.stringify('development')}}},
    server:{host:'127.0.0.1',port,strictPort:true,hmr:false,proxy:{'/api':{target:gatewayUrl,changeOrigin:true},'/auth':{target:upstreamUrl,changeOrigin:true},'/__qa':{target:upstreamUrl,changeOrigin:true},'/socket.io':{target:gatewayUrl,ws:true}}}});
   await vite.listen();base='http://127.0.0.1:'+vite.httpServer.address().port;process.env.PANEL_URL=base;
  }
  return {base,gatewayUrl,catalogUrl,skillsUrl,pool,database,temporary,projectId,state,catalog,skills,actors,close,cookie,
   loginUrl:key=>base+'/__qa/role/'+key,
   async request(key,route,{method='GET',body,status=200,headers={}}={}){
    const response=await originalFetch(gatewayUrl+route,{method,headers:{'content-type':'application/json','x-neurocenter-request':'1',origin:base,...(key?{cookie:cookie(key)}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(20000)});
    const text=await response.text();let value;try{value=text?JSON.parse(text):null;}catch{value=text;}
    assert.equal(response.status,status,method+' '+route+': '+JSON.stringify(value));return value;
   }};
 }catch(error){await close().catch(cleanup=>{console.error(cleanup);});throw error;}
}
