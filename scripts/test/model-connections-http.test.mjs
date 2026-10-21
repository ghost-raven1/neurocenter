import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {startSkillPackagingFixture} from './skill-packaging.fixture.mjs';

const adminUrl=process.env.MODEL_CONNECTION_TEST_ADMIN_URL;
const {modelScanDigest}=createRequire(import.meta.url)('../../services/shared/opencode-model-scan.cjs');

/** Real Gateway/Catalog, isolated database and local provider; no personal configuration or paid APIs. */
test('Model connection parameters and write-only credentials work through Gateway',{
 skip:!adminUrl?'Set MODEL_CONNECTION_TEST_ADMIN_URL to an owned disposable PostgreSQL port.':false,timeout:120_000,
},async t=>{
 const f=await startSkillPackagingFixture({adminUrl});let fixtureClosed=false;t.after(()=>fixtureClosed?undefined:f.close());
 const requests=[],secret='qa-model-key-'+randomUUID();let providerStatus=200;
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());requests.push({path:req.url,body,authorization:req.headers.authorization});
  res.writeHead(providerStatus,{'content-type':'application/json'});
  if(providerStatus!==200){res.end(JSON.stringify({error:{message:secret}}));return;}
  if(req.url.endsWith('/embeddings'))res.end(JSON.stringify({object:'list',model:body.model,data:body.input.map((_,index)=>({object:'embedding',index,embedding:[1,index+1,3]}))}));
  else if(req.url.endsWith('/chat/completions'))res.end(JSON.stringify({model:body.model,choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}]}));
  else res.end(JSON.stringify({model:body.model,message:{role:'assistant',content:'OK'},done:true,done_reason:'stop'}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const endpoint='http://127.0.0.1:'+server.address().port;
 const path=model=>'/api/models/'+model.id;
 const create=async(name,runtime='remote-openai',capability='chat')=>f.request('main','/api/models',{method:'POST',status:201,body:{
  requestKey:randomUUID(),name,runtime,capability,model:'qa-'+name.toLowerCase().replaceAll(' ','-'),modelVersion:'1',...(capability==='embedding'?{dimension:3}:{}),
 }});
 const read=model=>f.request('main',path(model));
 const connection=model=>f.request('main',path(model)+'/connection');
 const save=async(model,view,patch={},status=200,key='main')=>f.request(key,path(model)+'/connection',{method:'PUT',status,body:{
  expectedModelRevision:model.revision,expectedRevision:view.revision,baseUrl:endpoint+(model.runtime==='remote-openai'?'/v1':''),
  requestDimensions:false,credential:'stored',apiKey:secret,...patch,
 }});
 const verify=async model=>{
  await f.request('main',path(model)+'/hosting',{method:'POST',status:201,body:{action:'check',expectedRevision:model.revision}});
  for(let i=0;i<200;i++){
   const state=await f.request('main',path(model)+'/hosting');
   if(state.state!=='busy'){assert.equal(state.state,'ready',JSON.stringify(state));return read(model);}
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('Model verification did not finish.');
 };
 const infer=async(model,extra={},status=201)=>f.request('main',path(model)+'/ollama/v1/chat/completions',{method:'POST',status,
  body:{messages:[{role:'user',content:'Hello'}],...extra}});
 let chat,chatView,initialChat;
 await t.test('Private connection endpoints enforce authentication and main-admin role',async()=>{
  chat=await create('Gateway chat');
  await f.request(null,path(chat)+'/connection',{status:401});
  await f.request('developer',path(chat)+'/connection',{status:403});
  chatView=await connection(chat);assert.equal(chatView.canStoreKey,true);
  await save(chat,chatView,{},403,'developer');assert.equal((await connection(chat)).revision,0);
 });
 await t.test('Stored key is write-only and zero-valued defaults reach the provider',async()=>{
  chatView=await save(chat,chatView,{options:{temperature:0,topP:0,maxOutputTokens:512},timeoutMs:120000});
  assert.equal(chatView.modelRevision,(await read(chat)).revision);
  assert.deepEqual(chatView.options,{temperature:0,topP:0,maxOutputTokens:512});assert.equal(chatView.timeoutMs,120000);
  assert.equal(chatView.hasKey,true);assert.equal(JSON.stringify(chatView).includes(secret),false);
  chat=await verify(await read(chat));initialChat=chat;
  await infer(chat);assert.deepEqual(requests.at(-1).body,{model:chat.model,messages:[{role:'user',content:'Hello'}],stream:false,temperature:0,top_p:0,max_tokens:512});
  assert.equal(requests.at(-1).authorization,'Bearer '+secret);
  const rows=(await f.pool.query('SELECT * FROM model_remote_connections WHERE model_id=$1',[chat.id])).rows;
  assert.equal(JSON.stringify(rows).includes(secret),false);
  assert.equal(JSON.stringify((await f.pool.query('SELECT before_state,after_state FROM security_events')).rows).includes(secret),false);
  assert.equal(JSON.stringify(await read(chat)).includes(endpoint),false);
 });
 await t.test('Explicit request parameters override defaults and stale saves cannot overwrite them',async()=>{
  await infer(chat,{temperature:0.6,top_p:0.8,max_tokens:123});
  assert.equal(requests.at(-1).body.temperature,0.6);assert.equal(requests.at(-1).body.top_p,0.8);assert.equal(requests.at(-1).body.max_tokens,123);
  await save(initialChat,{...chatView,revision:0},{options:{}},409);
  assert.deepEqual((await connection(chat)).options,{temperature:0,topP:0,maxOutputTokens:512});
 });
 await t.test('Invalid and incompatible options fail before provider calls or database changes',async()=>{
  const before=requests.length,revision=(await connection(chat)).revision;
  for(const options of [{temperature:-1},{topP:1.1},{maxOutputTokens:0},{maxOutputTokens:32769},{contextWindow:127},{apiKey:'no'},{temperature:'0.2'}])
   await save(chat,await connection(chat),{options},400);
  for(const timeoutMs of [0,999,300001,1.5,'1000'])await save(chat,await connection(chat),{timeoutMs},400);
  assert.equal(requests.length,before);assert.equal((await connection(chat)).revision,revision);
 });
 await t.test('Clearing defaults preserves the saved key and uses provider defaults',async()=>{
  chatView=await save(chat,await connection(chat),{apiKey:undefined,options:{},timeoutMs:90000});
  assert.equal(chatView.hasKey,true);chat=await verify(await read(chat));await infer(chat);
  assert.equal(requests.at(-1).authorization,'Bearer '+secret);
  for(const name of ['temperature','top_p','max_tokens'])assert.equal(name in requests.at(-1).body,false);
  assert.notEqual(chat.verificationSha256,initialChat.verificationSha256);
 });
 await t.test('Ollama receives the configured context and native option names',async()=>{
  let model=await create('Gateway Ollama','remote-ollama');
  await save(model,await connection(model),{options:{temperature:0.2,topP:0.7,maxOutputTokens:256,contextWindow:8192},credential:'none',apiKey:undefined});
  model=await verify(await read(model));await infer(model);
  assert.deepEqual(requests.at(-1).body.options,{temperature:0.2,top_p:0.7,num_predict:256,num_ctx:8192});
  assert.equal(requests.at(-1).authorization,undefined);
 });
 await t.test('OpenAI declared context is used by chat planning without inventing an API parameter',async()=>{
  let model=await create('Declared context');
  await save(model,await connection(model),{options:{contextWindow:32768,maxOutputTokens:512}});
  model=await verify(await read(model));await infer(model);
  assert.equal('contextWindow' in requests.at(-1).body,false);assert.equal('num_ctx' in requests.at(-1).body,false);
  const detail=await f.request('main','/api/model-chats',{method:'POST',status:201,body:{modelId:model.id,expectedModelPin:model.modelPin}});
  assert.equal(detail.context.contextWindowTokens,32768);assert.equal(detail.context.reservedOutputTokens,512);
 });
 await t.test('Embedding only accepts compatible parameters and retains measured dimensions',async()=>{
  let model=await create('Gateway embedding','remote-openai','embedding');
  await save(model,await connection(model),{options:{temperature:0.2}},400);
  await save(model,await connection(model),{options:{},timeoutMs:60000,requestDimensions:true});
  model=await verify(await read(model));
  const response=await f.request('main',path(model)+'/ollama/v1/embeddings',{method:'POST',status:201,body:{input:['hello']}});
  assert.deepEqual(response.data[0].embedding,[1,1,3]);assert.equal(requests.at(-1).body.dimensions,3);
 });
 await t.test('Provider authorization errors are sanitized and a later retry works',async()=>{
  providerStatus=401;const failure=await infer(chat,{},503);assert.equal(JSON.stringify(failure).includes(secret),false);
  providerStatus=200;await infer(chat);assert.deepEqual(f.state.externalCalls,[]);
 });
 await t.test('OpenCode import carries bounded hints without copying keys or overwriting an existing connection',async()=>{
  const deviceId=randomUUID(),jobId=randomUUID(),candidateId=randomUUID(),instanceId=randomUUID(),bindingId='a'.repeat(64);
  const scan={schemaVersion:1,projectId:f.projectId,bindingId,instanceId,scanId:jobId,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900000).toISOString(),warnings:[],
   candidates:[{candidateId,provider:'qa',name:'OpenCode tuned model',model:'upstream-api-id',modelVersion:'1',capability:'chat',runtime:'remote-openai',baseUrl:endpoint+'/v1',
    hasKey:true,credentialSource:'environment',blocker:null,options:{temperature:0.3,topP:0.9,maxOutputTokens:256},timeoutMs:60000}],digest:''};
  scan.digest=modelScanDigest(scan);
  await f.pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report,revoked,expires_at) VALUES($1,$2,'Главный админ','QA model scan',$3,$4,$5,false,now()+interval '1 hour')",
   [deviceId,f.actors.main.email,'b'.repeat(64),'c'.repeat(64),JSON.stringify({bindings:[{projectId:f.projectId,bindingId,instanceId,folderName:'qa'}]})]);
  await f.pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,kind,state,project_id,payload,result,request_key,request_hash) VALUES($1,$2,$3,'Главный админ','scan-opencode-models','succeeded',$4,$5,$6,$1,$7)",
   [jobId,deviceId,f.actors.main.email,f.projectId,JSON.stringify({bindingId,instanceId}),JSON.stringify(scan),'d'.repeat(64)]);
  const importBody={deviceId,jobId,candidateId};
  const imported=await f.request('main','/api/models/import-opencode',{method:'POST',status:201,body:importBody});
  assert.deepEqual(imported.options,scan.candidates[0].options);assert.equal(imported.timeoutMs,60000);assert.equal(imported.hasKeyOnComputer,true);
  const draft=await connection(imported.model);assert.equal(draft.revision,0);assert.equal(draft.hasKey,false);
  await save(imported.model,draft,{options:{temperature:0.7},timeoutMs:30000});
  const before=await connection(imported.model),again=await f.request('main','/api/models/import-opencode',{method:'POST',status:201,body:importBody});
  assert.equal(again.model.id,imported.model.id);assert.equal(again.repeated,true);assert.deepEqual(await connection(imported.model),before);
  const changed=structuredClone(scan);changed.candidates[0].options.temperature=0.8;
  await f.pool.query('UPDATE bridge_jobs SET result=$2 WHERE id=$1',[jobId,JSON.stringify(changed)]);
  await f.request('main','/api/models/import-opencode',{method:'POST',status:409,body:importBody});
  assert.deepEqual(await connection(imported.model),before);
 });
 await t.test('Fixture cleanup waits for closing PostgreSQL sockets instead of terminating them',async()=>{
  const errors=[],clients=await Promise.all([f.pool.connect(),f.pool.connect()]);
  f.pool.on('error',error=>errors.push(error.code));let endingAt;
  const ended=clients.map(client=>new Promise(resolve=>{
   client.once('end',resolve);const end=client.end.bind(client);
   client.end=(...args)=>{endingAt??=performance.now();setTimeout(()=>end(...args),250);};client.release();
  }));
  fixtureClosed=true;await f.close();await Promise.all(ended);
  assert.deepEqual(errors,[],'Cleanup must not cause PostgreSQL administrator-termination errors.');
  assert.ok(performance.now()-endingAt>=200,'Database drop must wait for the delayed client disconnect.');
 });
});
