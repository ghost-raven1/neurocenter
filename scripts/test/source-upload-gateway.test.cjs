const {defaultFeatureFlags,evaluateFeatureFlags}=require('../../services/shared/feature-flags.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer,request}=require('node:http');
const {once}=require('node:events');
const {createRequire}=require('node:module');
const fs=require('node:fs');
const path=require('node:path');
const gatewayRequire=createRequire(path.resolve('services/api-gateway/package.json'));
const ts=gatewayRequire('typescript');
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText,filename);
const {ProxyService}=require('../../services/api-gateway/src/proxy/proxy.service.ts');
const {sourceUploadConnection}=require('../../services/api-gateway/src/proxy/source-upload-stream.ts');
const {browserSecurity}=require('../../services/api-gateway/src/security/browser-security.ts');
const {sourceUploadContentRoute}=require('../../services/shared/source-upload-route.cjs');
const {requiredFeatureFlags}=require('../../services/api-gateway/src/features/feature-flag-gate.ts');
const id='7428c85e-c645-4f05-b610-6f0029867f93',route='/api/tool-builds/uploads/'+id+'/content';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
const reply=(response,status,body)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(body));};
async function fixture({allowed=true,flag=true,early=false,responseData}={}){
 const calls=[],received=[];let aborted=false;
 const upstream=createServer((req,res)=>{
  if(req.url==='/internal/access/authorize'){req.resume();reply(res,200,{allowed:true,claims:{projects:[],pluginIds:[],skillPaths:[]}});return;}
  if(req.url==='/internal/feature-flags/evaluated'){reply(res,200,evaluateFeatureFlags({...defaultFeatureFlags(),tool_builds:flag}));return;}
  calls.push({url:req.url,headers:req.headers});
  if(early){reply(res,409,{message:'Upload was cancelled'});return;}
  req.on('aborted',()=>{aborted=true;});let bytes=0;
  req.on('data',chunk=>{bytes+=chunk.length;});req.on('end',()=>{received.push(bytes);reply(res,200,responseData??{id,state:'READY',bytes});});
 });
 const base=await listen(upstream),service=new ProxyService({get:key=>['CATALOG_SERVICE_URL','FEATURE_FLAGS_SERVICE_URL'].includes(key)?base:undefined},{authenticate:async()=>allowed?{userId:'fixture',email:'fixture@example.test',activeRole:'Главный админ',policies:[]}:null},{mutation(){}});
 const server=createServer((req,res)=>{
  req.path=new URL(req.url,'http://fixture').pathname;req.query={};
  res.status=function(status){res.statusCode=status;return res;};res.json=function(body){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));return res;};res.send=function(body){res.end(JSON.stringify(body));return res;};
  sourceUploadConnection(req,res,()=>browserSecurity(req,res,()=>{void service.forward(req,res).catch(error=>{reply(res,500,{message:error.message});});}));
 });
 const url=await listen(server);
 return {url,calls,received,allow:()=>{allowed=true;},aborted:()=>aborted,dispose:async()=>{await close(server);await close(upstream);}};
}
async function send(base,{url=route,headers={},body=Buffer.alloc(256*1024,7)}={}){
 return new Promise((resolve,reject)=>{const req=request(base+url,{method:'PUT',headers:{'content-type':'application/octet-stream','content-length':body.length,...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks)),headers:res.headers}));});req.on('error',reject);req.end(body);});
}
test('Raw stream uses Gateway RBAC, forwards identity and streams exact bytes without arbitrary response headers',async()=>{
 const f=await fixture();try{const response=await send(f.url);assert.equal(response.status,200);assert.equal(response.body.state,'READY');assert.deepEqual(f.received,[256*1024]);assert.equal(f.calls.length,1);assert.equal(f.calls[0].headers['content-type'],'application/octet-stream');assert.equal(JSON.parse(decodeURIComponent(f.calls[0].headers['x-bridge-actor'])).email,'fixture@example.test');assert.equal(response.headers['cache-control'],'no-store');}finally{await f.dispose();}
});
test('Canonical encoded upload route gets the same flag and raw forwarding; cleanup/status are not disabled',async()=>{
 const encoded=route.replace('uploads','%75ploads')+'/';assert.equal(sourceUploadContentRoute('PUT',encoded),route);
 assert.deepEqual(requiredFeatureFlags('PUT',encoded), ['tool_builds']);assert.deepEqual(requiredFeatureFlags('POST','/api/tool-builds/uploads'),['tool_builds']);assert.deepEqual(requiredFeatureFlags('DELETE','/api/tool-builds/uploads/'+id),[]);assert.deepEqual(requiredFeatureFlags('GET','/api/tool-builds/uploads/'+id),[]);
 const f=await fixture();try{assert.equal((await send(f.url,{url:encoded})).status,200);assert.equal(f.calls[0].url,route);}finally{await f.dispose();}
});
test('Access denial and feature disable happen before upload bytes reach catalog',async()=>{
 for(const options of [{allowed:false},{flag:false}]){const f=await fixture(options);try{const response=await send(f.url);assert.equal(response.status,options.allowed===false?401:403);assert.equal(f.calls.length,0);}finally{await f.dispose();}}
});
test('Wrong media and predeclared over-limit stream are rejected before the catalog data plane',async()=>{
 const f=await fixture();try{assert.equal((await send(f.url,{headers:{'content-type':'application/json'}})).status,415);assert.equal((await send(f.url,{headers:{'content-length':268435457},body:Buffer.from('x')})).status,413);assert.equal(f.calls.length,0);}finally{await f.dispose();}
});
test('Early input refusal closes the unfinished HTTP message before a keep-alive client retries',async()=>{
 for(const [status,options,headers] of [
  [401,{allowed:false},{'content-length':64}],
  [403,{}, {'content-length':64,cookie:'bridge_session=fixture','x-neurocenter-request':'0'}],
  [413,{}, {'content-length':268435457}],
  [415,{}, {'content-length':64,'content-type':'application/json'}],
 ]){
  const f=await fixture(options);try{
   const denied=await send(f.url,{headers,body:Buffer.from('x')});assert.equal(denied.status,status);assert.equal(denied.headers.connection,'close');
   f.allow();assert.equal((await send(f.url)).status,200);assert.equal(f.calls.length,1);
  }finally{await f.dispose();}
 }
});
test('Early catalog refusal is returned promptly and does not become a success',async()=>{
 const f=await fixture({early:true});try{const response=await send(f.url);assert.equal(response.status,409);assert.equal(response.body.message,'Upload was cancelled');}finally{await f.dispose();}
});
test('Client disconnect cancels upstream raw transfer',async()=>{
 const f=await fixture();try{
  const req=request(f.url+route,{method:'PUT',headers:{'content-type':'application/octet-stream','content-length':1024*1024}});req.on('error',()=>{});req.write(Buffer.alloc(1024));
  for(let n=0;n<100&&!f.calls.length;n++)await new Promise(resolve=>setTimeout(resolve,5));req.destroy();
  for(let n=0;n<100&&!f.aborted();n++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.aborted(),true);
 }finally{await f.dispose();}
});
test('Chunked actual-byte overflow is bounded at 256 MiB and aborts the upstream before READY',{timeout:30000},async()=>{
 const f=await fixture();try{
  const response=await new Promise((resolve,reject)=>{
   let answered=false;const req=request(f.url+route,{method:'PUT',headers:{'content-type':'application/octet-stream'}},res=>{
    answered=true;const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));
   });req.on('error',error=>{if(!answered)reject(error);});
   void(async()=>{const chunk=Buffer.alloc(64*1024);for(let index=0;index<4097&&!answered;index++)if(!req.write(chunk))await once(req,'drain');if(!answered)req.end();})().catch(error=>{if(!answered)reject(error);});
  });assert.equal(response.status,413);assert.match(response.body.message,/256/);assert.deepEqual(f.received,[]);
  for(let n=0;n<100&&!f.aborted();n++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.aborted(),true);
 }finally{await f.dispose();}
});
test('Asset repository archive streams exact bytes through the authenticated Gateway without the tool build flag',async()=>{
 const f=await fixture({flag:false});try{
  const body=Buffer.from('archive data plane'),response=await send(f.url,{url:'/api/asset-sources/archive',body});
  assert.equal(response.status,200);assert.deepEqual(f.received,[body.length]);assert.equal(f.calls[0].url,'/api/asset-sources/archive');
  assert.equal(f.calls[0].headers['content-type'],'application/octet-stream');assert.equal(response.headers.connection,'close');assert.equal(response.headers['cache-control'],'no-store');
 }finally{await f.dispose();}
});
test('Asset archive rejects media/size and unauthenticated input before forwarding its data plane',async()=>{
 const f=await fixture();try{
  const route='/api/asset-sources/archive';
  assert.equal((await send(f.url,{url:route,headers:{'content-type':'application/json'}})).status,415);
  assert.equal((await send(f.url,{url:route,headers:{'content-length':8*1024**3+1},body:Buffer.from('x')})).status,413);assert.equal(f.calls.length,0);
 }finally{await f.dispose();}
 const denied=await fixture({allowed:false});try{const response=await send(denied.url,{url:'/api/asset-sources/archive'});assert.equal(response.status,401);assert.equal(response.headers.connection,'close');assert.equal(denied.calls.length,0);}finally{await denied.dispose();}
});
test('Archive upload response can carry a full metadata list exceeding the ordinary small upload receipt',async()=>{
 const description='x'.repeat(1024*1024+128),f=await fixture({responseData:{source:{archiveSha256:'a'.repeat(64)},assets:[{description}]}});
 try{const response=await send(f.url,{url:'/api/asset-sources/archive',body:Buffer.from('archive')});assert.equal(response.status,200);assert.equal(response.body.assets[0].description,description);}finally{await f.dispose();}
});
test('Only the canonical asset archive PUT receives raw transport',()=>{
 const {assetSourceArchiveRoute,ASSET_SOURCE_ARCHIVE_MAX_BYTES}=require('../../services/shared/asset-source-archive-route.cjs');
 assert.equal(ASSET_SOURCE_ARCHIVE_MAX_BYTES,8*1024**3);
 assert.equal(assetSourceArchiveRoute('PUT','/api/%61sset-sources/archive/'),'/api/asset-sources/archive');
 for(const method of ['GET','POST','DELETE'])assert.equal(assetSourceArchiveRoute(method,'/api/asset-sources/archive'),undefined);
 for(const route of ['/api/asset-sources/archive-extra','/api/asset-sources/archive/child','/api/asset-sources/../archive','/api/asset-sources/%2e%2e/archive','/api/%ZZ/asset-sources/archive'])assert.equal(assetSourceArchiveRoute('PUT',route),undefined);
});
