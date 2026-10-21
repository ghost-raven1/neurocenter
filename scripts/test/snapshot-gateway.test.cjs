const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer,request}=require('node:http');
const {once}=require('node:events');
const {createHash}=require('node:crypto');
const {createRequire}=require('node:module');
const fs=require('node:fs');
const path=require('node:path');
const gatewayRequire=createRequire(path.resolve('services/api-gateway/package.json')),ts=gatewayRequire('typescript');
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText,filename);
const {ProxyService}=require('../../services/api-gateway/src/proxy/proxy.service.ts');
const {sourceUploadConnection}=require('../../services/api-gateway/src/proxy/source-upload-stream.ts');
const {browserSecurity}=require('../../services/api-gateway/src/security/browser-security.ts');
const {snapshotContentRoute,snapshotDownloadRoute,snapshotPublicationRoute}=require('../../services/shared/snapshot-content-route.cjs');
const projectId='prj-snapshot-qa',snapshotId='7428c85e-c645-4f05-b610-6f0029867f93',jobId='6428c85e-c645-4f05-b610-6f0029867f93',lease='5428c85e-c645-4f05-b610-6f0029867f93';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),payload=Buffer.from([0,255,13,10,123,34,128,0]),digest=sha(payload),maximum=64*1024**2;
const upload=`/api/projects/${projectId}/snapshot-uploads/${snapshotId}/blobs/${digest}`,download=`/api/projects/${projectId}/versions/${snapshotId}/blobs/${digest}`;
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
const reply=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
const waitFor=async check=>{for(let n=0;n<150&&!check();n++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(check(),true);};
async function fixture({identity='device',allowed=true,job={},jobStatus=200,mode='normal'}={}){
 const calls=[],uploads=[],decisions=[],leases=[];let uploadAborted=false,downloadAborted=false;
 const upstream=createServer((req,res)=>{
  if(req.url.startsWith('/internal/device-channel/jobs/')){let data='';req.on('data',value=>data+=value);req.on('end',()=>{leases.push({headers:req.headers,input:JSON.parse(data)});reply(res,jobStatus,{projectId,snapshotId,snapshotProtocol:'project-snapshots-v1',role:'Разработчик',...job});});return;}
  if(req.url==='/internal/access/authorize'){let data='';req.on('data',value=>data+=value);req.on('end',()=>{decisions.push(JSON.parse(data));reply(res,200,{allowed,claims:{projects:[],pluginIds:[],skillPaths:[]}});});return;}
  if(req.url==='/internal/feature-flags/evaluated'){reply(res,200,{flags:{rag_sync:true}});return;}
  calls.push({url:req.url,method:req.method,headers:req.headers});
  if(req.method==='PUT'){
   if(mode==='early'){reply(res,409,{message:'Publication closed'});return;}
   const hash=createHash('sha256');let bytes=0;req.on('aborted',()=>{uploadAborted=true;});req.on('data',value=>{bytes+=value.length;hash.update(value);});req.on('end',()=>{uploads.push({bytes,sha256:hash.digest('hex')});reply(res,200,{sha256:uploads.at(-1).sha256,bytes});});return;
  }
  if(req.url.includes('/versions/')&&req.url.includes('/blobs/')){
   if(mode==='denied'){reply(res,403,{message:'Snapshot unavailable'});return;}
   const bytes=mode==='corrupt'?Buffer.alloc(payload.length,9):payload;
   res.writeHead(200,{'content-type':'application/octet-stream','content-length':mode==='slow'?maximum:mode==='oversize'?maximum+1:bytes.length,'set-cookie':'private=never-forward','x-private':'never-forward'});
   if(req.method==='HEAD'){res.end();return;}
   if(mode==='truncated'){res.write(bytes.subarray(0,2));setTimeout(()=>res.destroy(),10);return;}
   if(mode==='slow'){
    res.write(Buffer.alloc(1024));const timer=setInterval(()=>res.write(Buffer.alloc(1024)),10);res.on('close',()=>{downloadAborted=!res.writableEnded;clearInterval(timer);});return;
   }
   res.end(bytes);return;
  }
  reply(res,200,{status:'UPLOADING',snapshotId});
 });
 const base=await listen(upstream),service=new ProxyService({get:key=>['CATALOG_SERVICE_URL','FEATURE_FLAGS_SERVICE_URL'].includes(key)?base:undefined},{authenticate:async()=>identity==='none'?null:{userId:'qa',email:'qa@example.test',activeRole:'Наблюдатель',policies:[],...(identity==='device'?{deviceId:'device-qa'}:{})}},{mutation(){}});
 const server=createServer((req,res)=>{
  req.path=new URL(req.url,'http://fixture').pathname;req.query={};
  res.status=function(status){res.statusCode=status;return res;};res.set=function(headers){for(const[key,value]of Object.entries(headers))res.setHeader(key,value);return res;};
  res.json=function(body){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));return res;};res.send=function(body){res.end(Buffer.isBuffer(body)?body:JSON.stringify(body));return res;};
  sourceUploadConnection(req,res,()=>browserSecurity(req,res,()=>{void service.forward(req,res).catch(error=>{if(!res.headersSent)reply(res,500,{message:error.message});else res.destroy();});}));
 });
 return {url:await listen(server),calls,uploads,leases,decisions,uploadAborted:()=>uploadAborted,downloadAborted:()=>downloadAborted,dispose:async()=>{await close(server);await close(upstream);}};
}
const leaseHeaders={'authorization':'Bearer own-device','x-neurocenter-job-id':jobId,'x-neurocenter-job-lease':lease};
async function send(base,{method='PUT',route=upload,headers={},body=payload,withLease=true}={}){
 return new Promise((resolve,reject)=>{
  const req=request(base+route,{method,headers:{...(withLease?leaseHeaders:{}),...(method==='PUT'?{'content-type':'application/octet-stream','content-length':body.length}:{}),...headers}},res=>{
   const chunks=[];let settled=false;const finish=complete=>{if(settled)return;settled=true;resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks),complete});};res.on('data',value=>chunks.push(value));res.on('end',()=>finish(true));res.on('aborted',()=>finish(false));res.on('error',()=>finish(false));
  });req.on('error',reject);req.end(method==='PUT'?body:undefined);
 });
}
test('Publication/download canonical routes keep binary plane separate from JSON control',()=>{
 assert.equal(snapshotContentRoute('PUT',upload.replace('snapshot-uploads','%73napshot-uploads')+'/'),upload);assert.equal(snapshotDownloadRoute('HEAD',download),download);assert.deepEqual(snapshotPublicationRoute('GET',`/api/projects/${projectId}/snapshot-uploads/${snapshotId}/status`),{projectId,snapshotId});
 for(const route of [upload+'/extra',upload.replace('/blobs/','/../blobs/'),upload.replace(projectId,'../private'),upload.replace(digest,'not-a-sha')])assert.equal(snapshotContentRoute('PUT',route),undefined);
 assert.equal(snapshotPublicationRoute('DELETE',upload),undefined);assert.equal(snapshotDownloadRoute('POST',download),undefined);
});
test('Device publication streams exact binary bytes after purpose/lease/RBAC, with actor role from actual job',async()=>{
 const f=await fixture();try{const response=await send(f.url);assert.equal(response.status,200);assert.deepEqual(f.uploads,[{bytes:payload.length,sha256:digest}]);assert.equal(f.calls.length,1);assert.deepEqual(f.leases[0].input,{lease});assert.equal(f.decisions[0].activeRole,'Разработчик');const actor=JSON.parse(decodeURIComponent(f.calls[0].headers['x-bridge-actor']));assert.equal(actor.email,'qa@example.test');assert.equal(actor.activeRole,'Разработчик');assert.equal(response.headers.connection,'close');assert.equal(response.headers['cache-control'],'no-store');
 }finally{await f.dispose();}
});
test('Wrong project/snapshot/protocol, expired lease, malformed or absent lease never reaches publication',async()=>{
 for(const options of [{job:{projectId:'other'}},{job:{snapshotId:jobId}},{job:{snapshotProtocol:'row-sync-v1'}},{jobStatus:403},{headers:{'x-neurocenter-job-lease':'bad'}},{withLease:false}]){
  const f=await fixture(options);try{const response=await send(f.url,options);assert.equal(response.status,403);assert.equal(f.calls.length,0);}finally{await f.dispose();}
 }
});
test('Missing login, denied project role and browser CSRF are refused before any raw catalog bytes',async()=>{
 for(const[options,input,status]of [[{identity:'none'},{},401],[{allowed:false},{},403],[{identity:'browser'},{withLease:false,headers:{cookie:'bridge_session=own','x-neurocenter-request':'0'}},403]]){
  const f=await fixture(options);try{const result=await send(f.url,input);assert.equal(result.status,status);assert.equal(result.headers.connection,'close');assert.equal(f.calls.length,0);}finally{await f.dispose();}
 }
});
test('Wrong media, empty and declared >64MiB streams are rejected independently of old256MiB source uploads',async()=>{
 const f=await fixture();try{for(const[headers,status]of [[{'content-type':'application/json'},415],[{'content-length':'0'},413],[{'content-length':String(maximum+1)},413]]){const response=await send(f.url,{headers,body:Buffer.alloc(0)});assert.equal(response.status,status);assert.equal(response.headers.connection,'close');}assert.equal(f.calls.length,0);
 }finally{await f.dispose();}
});
test('Exactly64MiB actual opaque body is accepted with identical server byteSHA',{timeout:30000},async()=>{
 const f=await fixture(),chunk=Buffer.alloc(64*1024);for(let i=0;i<chunk.length;i++)chunk[i]=i%256;const expected=createHash('sha256');for(let i=0;i<1024;i++)expected.update(chunk);const expectedSha=expected.digest('hex');
 try{const result=await new Promise((resolve,reject)=>{
  const req=request(f.url+upload.replace(digest,expectedSha),{method:'PUT',headers:{...leaseHeaders,'content-type':'application/octet-stream','content-length':maximum}},res=>{let text='';res.on('data',value=>text+=value);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);
  void(async()=>{for(let i=0;i<1024;i++)if(!req.write(chunk))await once(req,'drain');req.end();})().catch(reject);
 });assert.equal(result.status,200);assert.deepEqual(f.uploads,[{bytes:maximum,sha256:expectedSha}]);assert.equal(result.body.bytes,maximum);
 }finally{await f.dispose();}
});
test('Chunked actual >64MiB aborts upstream and never reports accepted bytes',{timeout:30000},async()=>{
 const f=await fixture();try{const result=await new Promise((resolve,reject)=>{
  let answered=false;const req=request(f.url+upload,{method:'PUT',headers:{...leaseHeaders,'content-type':'application/octet-stream'}},res=>{answered=true;let text='';res.on('data',value=>text+=value);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',error=>{if(!answered)reject(error);});
  void(async()=>{const chunk=Buffer.alloc(64*1024);for(let i=0;i<1025&&!answered;i++)if(!req.write(chunk))await once(req,'drain');if(!answered)req.end();})().catch(error=>{if(!answered)reject(error);});
 });assert.equal(result.status,413);assert.match(result.body.message,/64/);assert.deepEqual(f.uploads,[]);await waitFor(f.uploadAborted);
 }finally{await f.dispose();}
});
test('A disconnected publisher aborts the in-flight raw catalog request',async()=>{
 const f=await fixture();try{const req=request(f.url+upload,{method:'PUT',headers:{...leaseHeaders,'content-type':'application/octet-stream','content-length':1024*1024}});req.on('error',()=>{});req.write(Buffer.alloc(1024));await waitFor(()=>f.calls.length===1);req.destroy();await waitFor(f.uploadAborted);
 }finally{await f.dispose();}
});
test('GET blob is exact binary, HEAD has exact size with no body, and only safe headers are forwarded',async()=>{
 const f=await fixture({identity:'browser'});try{const get=await send(f.url,{method:'GET',route:download,withLease:false});assert.equal(get.status,200);assert.equal(get.complete,true);assert.deepEqual(get.bytes,payload);assert.equal(sha(get.bytes),digest);assert.equal(get.headers['content-type'],'application/octet-stream');assert.equal(get.headers['content-length'],String(payload.length));assert.equal(get.headers['cache-control'],'no-store');assert.equal(get.headers['set-cookie'],undefined);assert.equal(get.headers['x-private'],undefined);
  const head=await send(f.url,{method:'HEAD',route:download,withLease:false});assert.equal(head.status,200);assert.equal(head.headers['content-length'],String(payload.length));assert.equal(head.bytes.length,0);
 }finally{await f.dispose();}
});
test('Upstream missing/oversize blocks fail closed rather than becoming valid binary downloads',async()=>{
 for(const[mode,status]of [['denied',403],['oversize',502]]){const f=await fixture({identity:'browser',mode});try{const response=await send(f.url,{method:'GET',route:download,withLease:false});assert.equal(response.status,status);assert.equal(response.headers['content-type'],'application/json');}finally{await f.dispose();}}
});
test('A corrupt or truncated GET cannot deliver a complete accepted block',async()=>{
 for(const mode of ['corrupt','truncated']){const f=await fixture({identity:'browser',mode});try{
  const response=await send(f.url,{method:'GET',route:download,withLease:false}).catch(()=>({status:502,complete:false}));assert.equal(response.status!==200||!response.complete,true,'Gateway must refuse a completed corrupt binary response');
 }finally{await f.dispose();}}
});
test('Download client disconnect aborts the upstream read stream',async()=>{
 const f=await fixture({identity:'browser',mode:'slow'});try{await new Promise((resolve,reject)=>{const req=request(f.url+download,{method:'GET'},res=>{res.once('data',()=>{res.destroy();req.destroy();resolve();});res.on('error',()=>{});});req.on('error',()=>{});req.end();setTimeout(()=>reject(Error('No streamed bytes')),2000).unref();});await waitFor(f.downloadAborted);
 }finally{await f.dispose();}
});
