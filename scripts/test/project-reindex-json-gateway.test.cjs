const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {once}=require('node:events');
const {createRequire}=require('node:module');
const path=require('node:path');
const gatewayRequire=createRequire(path.resolve('services/api-gateway/package.json'));
const express=gatewayRequire('express');
const {ProxyService}=require(path.resolve(process.env.GATEWAY_TEST_DIST||'services/api-gateway/dist','proxy/proxy.service.js'));
const route='/api/projects/prj-reindex-qa/embedding/reindex';

/** Real Express send(null) differs from json(null); a response mock cannot catch this regression. */
async function fixture(){
 const cases=new Map([
  ['empty-plan',{status:200,type:'application/json; charset=utf-8',body:'null'}],
  ['structured-json-null',{status:200,type:'application/problem+json; charset=utf-8',body:'null'}],
  ['object',{status:200,type:'application/json',body:'{"state":"applied","dimension":7}'}],
  ['array',{status:200,type:'application/json',body:'[1,2,3]'}],
  ['boolean',{status:200,type:'application/json',body:'false'}],
  ['zero',{status:200,type:'application/json',body:'0'}],
  ['plain-text',{status:200,type:'text/plain; charset=utf-8',body:'plain response'}],
  ['no-content',{status:204,type:'application/json',body:''}],
  ['conflict',{status:409,type:'application/json',body:'{"message":"stale selection"}'}],
 ]);
 const calls=[];
 const upstream=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/internal/access/authorize'){
   req.resume();res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify({allowed:true,claims:{email:'qa@example.test',userRoles:['Главный админ'],projects:[],pluginIds:[],skillPaths:[]}}));return;
  }
  assert.equal(url.pathname,route);calls.push(url.searchParams.get('case'));
  const item=cases.get(url.searchParams.get('case'));assert.ok(item);
  res.writeHead(item.status,{'content-type':item.type});res.end(item.body);
 });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const proxy=new ProxyService({get:key=>key==='CATALOG_SERVICE_URL'?`http://127.0.0.1:${upstream.address().port}`:undefined},
  {authenticate:async()=>({userId:'qa',email:'qa@example.test',activeRole:'Главный админ',policies:{}})},{mutation(){}});
 const app=express();app.use((req,res,next)=>{void proxy.forward(req,res).catch(next);});
 const gateway=createServer(app);gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 return {url:`http://127.0.0.1:${gateway.address().port}${route}`,calls,cases,close:async()=>{
  gateway.closeAllConnections();upstream.closeAllConnections();
  await Promise.all([new Promise(resolve=>gateway.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);
 }};
}

test('Fresh project RAG plan stays literal JSON null through actual Gateway HTTP and Express',async()=>{
 const app=await fixture();try{
  const response=await fetch(app.url+'?case=empty-plan');
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^application\/json/);
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.toString('utf8'),'null');assert.equal(JSON.parse(bytes),null);
  assert.equal(response.headers.get('content-length'),'4');assert.deepEqual(app.calls,['empty-plan']);
 }finally{await app.close();}
});

test('Null fix preserves other JSON values, text, status codes and genuinely empty204 responses',async()=>{
 const app=await fixture();try{for(const [name,item]of app.cases){
  const response=await fetch(app.url+'?case='+name);assert.equal(response.status,item.status,name);
  const text=await response.text();assert.equal(text,item.body,name);
  if(item.status!==204)assert.equal(response.headers.get('content-type').split(';')[0],item.type.split(';')[0],name);
 }}finally{await app.close();}
});
