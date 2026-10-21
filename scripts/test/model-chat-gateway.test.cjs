const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {EventEmitter,once}=require('node:events');
const {createServer}=require('node:http');
const {setImmediate:tick}=require('node:timers/promises');
const {ProxyService}=require(path.resolve(process.env.GATEWAY_TEST_DIST||'services/api-gateway/dist','proxy/proxy.service.js'));
const {modelInferenceRoute,forwardModelInference}=require(path.resolve(process.env.GATEWAY_TEST_DIST||'services/api-gateway/dist','proxy/model-inference-forward.js'));
const {requiredFeatureFlag}=require(path.resolve(process.env.GATEWAY_TEST_DIST||'services/api-gateway/dist','features/feature-flag-gate.js'));
const route='/api/models/model-fixture/ollama/v1/chat/completions';
const reply={model:'fixture-model',choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}]};
const identity={email:'chat@example.test',activeRole:'Главный админ'};
const claims={projects:[],pluginIds:[],skillPaths:[]};
function fixture(){
 const calls=[];
 const req=Object.assign(new EventEmitter(),{path:route,method:'POST',headers:{},query:{},body:{messages:[{role:'user',content:'Hello'}]},aborted:false});
 const res=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,writes:0,code:0,status(code){this.code=code;return this;},setHeader(){},send(body){this.body=body;this.writes++;this.writableEnded=true;return this;},json(body){return this.send(body);}});
 let request;
 const http={request:async config=>{calls.push(config);return request?request(config):{status:201,headers:{'content-type':'application/json'},data:reply};}};
 return {req,res,http,calls,transport:callback=>{request=callback;}};
}
const response=()=>({status:201,headers:{'content-type':'application/json'},data:reply});
for(const suffix of ['api/chat','api/embed','v1/chat/completions','v1/embeddings'])test('Only model POST inference uses cancellation: '+suffix,()=>{
 assert.equal(modelInferenceRoute('POST','/api/models/a/ollama/'+suffix),true);
 assert.equal(modelInferenceRoute('GET','/api/models/a/ollama/'+suffix),false);
 assert.equal(modelInferenceRoute('POST','/api/models/a/ollama/'+suffix+'/extra'),false);
});
for(const value of [undefined,'/api/models/a/hosting','/api/models/a/connection','/api/rag/sync'])test('Other routes keep their existing transport: '+value,()=>assert.equal(modelInferenceRoute('POST',value),false));
const savedRoot='/api/model-chats/12345678-1234-4234-8234-123456789abc';
for(const suffix of ['attachments','turns','turns/12345678-1234-4234-8234-123456789abc/retry'])test('Saved chat processing propagates client cancellation: '+suffix,async()=>{
 const savedRoute=savedRoot+'/'+suffix;
 assert.equal(modelInferenceRoute('POST',savedRoute),true);assert.equal(modelInferenceRoute('GET',savedRoute),false);
 assert.equal(requiredFeatureFlag('POST',savedRoute,{}),suffix==='attachments'?undefined:'model_hosting');
 const f=fixture();f.req.path=savedRoute;f.transport(config=>new Promise((_resolve,reject)=>config.signal.addEventListener('abort',()=>reject(Error('cancel')),{once:true})));
 const pending=forwardModelInference(f.http,{},f.req,f.res);f.res.destroyed=true;f.res.emit('close');assert.equal(await pending,undefined);
 assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.calls[0].maxContentLength,64*1024*1024);assert.equal(f.res.writes,0);
});
test('Saved chat inspection and cancellation remain available when inference is disabled',()=>{
 for(const suffix of ['','/context-preview','/turns/12345678-1234-4234-8234-123456789abc/cancel']){
  assert.equal(modelInferenceRoute('POST',savedRoot+suffix),false);assert.equal(requiredFeatureFlag('POST',savedRoot+suffix,{}),undefined);
 }
});
test('A completed inference keeps its configured deadline and cleans listeners',async()=>{
 const f=fixture();const result=await forwardModelInference(f.http,{url:'http://catalog.fixture'},f.req,f.res);
 assert.deepEqual(result,response());assert.equal(f.calls[0].timeout,610000);assert.equal(f.calls[0].maxContentLength,8*1024*1024);
 assert.equal(f.calls[0].signal.aborted,false);assert.equal(f.req.listenerCount('aborted'),0);assert.equal(f.res.listenerCount('close'),0);
 f.req.emit('close');f.res.writableEnded=true;f.res.emit('close');assert.equal(f.calls[0].signal.aborted,false);
});
for(const reason of ['aborted','response-close'])test('Client '+reason+' cancels upstream and cleans listeners',async()=>{
 const f=fixture();f.transport(config=>new Promise((_resolve,reject)=>config.signal.addEventListener('abort',()=>reject(Error('Cancelled fixture request')),{once:true})));
 const pending=forwardModelInference(f.http,{},f.req,f.res);await tick();
 if(reason==='aborted')f.req.emit('aborted');else f.res.emit('close');
 assert.equal(await pending,undefined);assert.equal(f.calls[0].signal.aborted,true);
 assert.equal(f.req.listenerCount('aborted'),0);assert.equal(f.res.listenerCount('close'),0);assert.equal(f.res.writes,0);
});
for(const state of ['request','response','ended'])test('Already closed '+state+' never starts inference',async()=>{
 const f=fixture();if(state==='request')f.req.aborted=true;else if(state==='response')f.res.destroyed=true;else f.res.writableEnded=true;
 assert.equal(await forwardModelInference(f.http,{},f.req,f.res),undefined);assert.equal(f.calls.length,0);
 assert.equal(f.req.listenerCount('aborted'),0);assert.equal(f.res.listenerCount('close'),0);
});
for(const outcome of ['success','failure'])test('Late upstream '+outcome+' cannot write after disconnect',async()=>{
 const f=fixture();f.transport(async()=>{f.res.destroyed=true;if(outcome==='failure')throw Error('PRIVATE failure');return response();});
 assert.equal(await forwardModelInference(f.http,{},f.req,f.res),undefined);assert.equal(f.res.writes,0);
 assert.equal(f.req.listenerCount('aborted'),0);assert.equal(f.res.listenerCount('close'),0);
});
test('Connected upstream errors still reach the existing Gateway error handler',async()=>{
 const f=fixture(),cause=Error('Synthetic upstream failure');f.transport(async()=>{throw cause;});
 await assert.rejects(forwardModelInference(f.http,{},f.req,f.res),cause);
 assert.equal(f.req.listenerCount('aborted'),0);assert.equal(f.res.listenerCount('close'),0);
});
test('Cancellation is isolated from another call to the same model and does not retry',async()=>{
 const first=fixture(),second=fixture();let complete;
 first.transport(config=>new Promise((_resolve,reject)=>config.signal.addEventListener('abort',()=>reject(Error('cancel')),{once:true})));
 second.transport(()=>new Promise(resolve=>{complete=()=>resolve(response());}));
 const cancelled=forwardModelInference(first.http,{},first.req,first.res),survivor=forwardModelInference(second.http,{},second.req,second.res);
 first.req.emit('aborted');complete();assert.equal(await cancelled,undefined);assert.deepEqual(await survivor,response());
 assert.equal(first.calls.length,1);assert.equal(second.calls.length,1);assert.equal(second.calls[0].signal.aborted,false);
});
for(const stage of ['authentication','authorization','feature-flag'])test('Disconnect during '+stage+' never starts a late inference or writes a reply',async()=>{
 const f=fixture();let release;
 const wait=new Promise(resolve=>{release=resolve;});
 const proxy=new ProxyService({get:()=>undefined},{authenticate:async()=>{if(stage==='authentication')await wait;return identity;}},{mutation(){}});
 proxy.http={
  post:async()=>{if(stage==='authorization')await wait;return {status:200,data:{allowed:true,claims}};},
  get:async()=>{if(stage==='feature-flag')await wait;return {status:200,data:{flags:{tool_builds:true,model_hosting:true,rag_sync:true}}};},
  request:async config=>{f.calls.push(config);return response();},
 };
 const pending=proxy.forward(f.req,f.res);await tick();f.res.destroyed=true;f.res.emit('close');release();await pending;
 assert.equal(f.calls.length,0);assert.equal(f.res.writes,0);
 assert.equal(f.req.listenerCount('aborted'),0);assert.equal(f.res.listenerCount('close'),0);
});

const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;};
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
const deadline=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('HTTP cancellation deadline exceeded')),5000);})]);}finally{clearTimeout(timer);}};

test('Actual Gateway HTTP disconnect closes the Catalog request before an explicit retry',async t=>{
 let arrivals=0,catalogCancelled,catalogStarted,finish;
 const started=new Promise(resolve=>{catalogStarted=resolve;}),cancelled=new Promise(resolve=>{catalogCancelled=resolve;});
 const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 const catalog=createServer(async(req,res)=>{
  for await(const _chunk of req){}
  if(req.url==='/internal/access/authorize')return json(res,200,{allowed:true,claims});
  if(req.url==='/internal/feature-flags/evaluated')return json(res,200,{flags:{tool_builds:true,model_hosting:true,rag_sync:true}});
  assert.equal(req.url,route);arrivals++;
  if(arrivals===1){res.on('close',()=>{if(!res.writableEnded)catalogCancelled();});catalogStarted();finish=()=>json(res,201,reply);return;}
  json(res,201,reply);
 });
 const catalogUrl=await listen(catalog);t.after(()=>close(catalog));
 const proxy=new ProxyService({get:key=>['CATALOG_SERVICE_URL','FEATURE_FLAGS_SERVICE_URL'].includes(key)?catalogUrl:undefined},{authenticate:async()=>identity},{mutation(){throw Error('Inference must not mutate the catalog');}});
 const gateway=createServer(async(req,res)=>{
  req.path=new URL(req.url,'http://fixture').pathname;req.query={};const chunks=[];for await(const chunk of req)chunks.push(chunk);req.body=JSON.parse(Buffer.concat(chunks));
  res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};res.send=res.json;
  await proxy.forward(req,res);
 });
 const gatewayUrl=await listen(gateway);t.after(()=>close(gateway));
 const abort=new AbortController(),headers={'content-type':'application/json'},body=JSON.stringify({messages:[{role:'user',content:'Hello'}],stream:false});
 const pending=fetch(gatewayUrl+route,{method:'POST',headers,body,signal:abort.signal});pending.catch(()=>{});
 await deadline(started);abort.abort();await assert.rejects(pending);await deadline(cancelled);assert.equal(arrivals,1);
 const next=await fetch(gatewayUrl+route,{method:'POST',headers,body});assert.equal(next.status,201);assert.deepEqual(await next.json(),reply);assert.equal(arrivals,2);
 finish();await tick();
});
