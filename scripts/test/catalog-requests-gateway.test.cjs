const {defaultFeatureFlags,evaluateFeatureFlags}=require('../../services/shared/feature-flags.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {once}=require('node:events');
const path=require('node:path');
const fs=require('node:fs');
const {ProxyService}=require(path.resolve('services/api-gateway/dist/proxy/proxy.service.js'));
const {LiveService}=require(path.resolve('services/api-gateway/dist/live/live.service.js'));

test('Built Swagger artifact includes usable request filters and submission/review bodies',()=>{
 const document=JSON.parse(fs.readFileSync(path.resolve('services/api-gateway/dist/docs/openapi.json'),'utf8'));
 const requests=document.paths['/api/catalog-requests'];
 assert.deepEqual(requests.get.parameters.map(item=>item.name),['scope','status','kind','assetType','projectId','page','size']);
 assert.deepEqual(requests.post.requestBody.content['application/json'].schema.required,['requestKey','kind','assetType','title','description']);
 assert.deepEqual(document.paths['/api/catalog-requests/{id}/actions'].post.requestBody.content['application/json'].schema.required,['requestKey','expectedRevision','action']);
});

/** An isolated HTTP upstream captures only synthetic actors; no catalog or live database is used. */
async function fixture({identity='human',allowed=true,status=201}={}){
 const calls=[],mutations=[];
 const upstream=createServer((req,res)=>{
  if(req.url==='/internal/feature-flags/evaluated'){res.setHeader('content-type','application/json');res.end(JSON.stringify(evaluateFeatureFlags(defaultFeatureFlags())));return;}
  let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{
   const body=text?JSON.parse(text):undefined;
   calls.push({url:req.url,method:req.method,headers:req.headers,body});
   res.setHeader('content-type','application/json');
   if(req.url==='/internal/access/authorize'){res.end(JSON.stringify({allowed,claims:{userRoles:['Наблюдатель'],projects:[],pluginIds:[],skillPaths:[]}}));return;}
   res.statusCode=status;res.end(JSON.stringify({id:'fixture-request',status:'submitted',title:'Private request description'}));
  });
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const auth=identity==='none'?null:{userId:'fixture-user',email:'fixture@example.test',principalName:'fixture@example.test',activeRole:'Наблюдатель',userRoles:['Наблюдатель'],policies:{},...(identity==='device'?{deviceId:'fixture-device'}:{})};
 const proxy=new ProxyService({get:key=>['CATALOG_SERVICE_URL','FEATURE_FLAGS_SERVICE_URL'].includes(key)?'http://127.0.0.1:'+upstream.address().port:undefined},
  {authenticate:async()=>auth},{mutation:(...input)=>mutations.push(input)});
 const server=createServer((req,res)=>{
  req.path=new URL(req.url,'http://fixture').pathname;req.query={};req.body={kind:'add',assetType:'skill',title:'Fixture'};
  res.status=function(code){this.statusCode=code;return this;};res.json=function(data){this.setHeader('content-type','application/json');this.end(JSON.stringify(data));return this;};res.send=function(data){this.end(JSON.stringify(data));return this;};
  void proxy.forward(req,res).catch(error=>{res.statusCode=500;res.end(error.message);});
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {url:'http://127.0.0.1:'+server.address().port+'/api/catalog-requests',calls,mutations,async close(){server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);}};
}

for(const [identity,allowed,status]of [['none',true,401],['device',true,403],['human',false,403]])test('Catalog requests rejects '+identity+' allowed='+allowed+' before resource access',async()=>{
 const app=await fixture({identity,allowed});try{
  assert.equal((await fetch(app.url,{method:'POST'})).status,status);
  assert.equal(app.calls.filter(item=>item.url!=='/internal/access/authorize').length,0);
  assert.equal(app.mutations.length,0);
 }finally{await app.close();}
});

test('Catalog request uses the authenticated actor, forwards to catalog and invalidates only after success',async()=>{
 const app=await fixture();try{
  const response=await fetch(app.url,{method:'POST',headers:{'x-bridge-actor':'forged','x-neurocenter-internal':'forged'}});
  assert.equal(response.status,201);
  const call=app.calls.find(item=>item.url==='/api/catalog-requests');
  assert.equal(JSON.parse(decodeURIComponent(call.headers['x-bridge-actor'])).email,'fixture@example.test');
  assert.notEqual(call.headers['x-neurocenter-internal'],'forged');
  assert.equal(app.mutations.length,1);
  assert.equal(app.mutations[0][0],'/api/catalog-requests');
 }finally{await app.close();}
 const conflict=await fixture({status:409});try{assert.equal((await fetch(conflict.url,{method:'POST'})).status,409);assert.equal(conflict.mutations.length,0);}finally{await conflict.close();}
});

test('Request invalidation carries no private contents and respects route boundaries',()=>{
 const events=[],live=new LiveService();live.attach({emit:(name,payload)=>events.push({name,payload})});
 live.mutation('/api/catalog-requests/request-qa/actions','private@example.test',{title:'private title',description:'private source',comment:'private comment'},'POST');
 assert.equal(events.length,1);assert.equal(events[0].name,'section:changed');
 assert.deepEqual(events[0].payload.sections,['requests','audit']);
 assert.doesNotMatch(JSON.stringify(events),/private/);
 live.mutation('/api/catalog-requests-extra','private@example.test',{},'POST');assert.equal(events.length,1);
});
