import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startModelChatFixture} from './model-chat.fixture.mjs';

const adminUrl=process.env.MODEL_CHAT_TEST_ADMIN_URL;
const waitFor=async(predicate,message)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error(message);};

test('Model chat through real Gateway/Catalog preserves context, rights, defaults and cancellation',{
 skip:!adminUrl?'Set MODEL_CHAT_TEST_ADMIN_URL to an owned disposable PostgreSQL port.':false,timeout:120000,
},async t=>{
 const f=await startModelChatFixture({adminUrl});t.after(()=>f.close());
 const model=f.cards[0],route='/api/models/'+model.id+'/ollama/v1/chat/completions',projectRoute=route+'?projectId='+f.projectId;
 const messages=[{role:'user',content:'Привет'}];
 const send=(key='main',history=messages,status=201,url=projectRoute)=>f.request(key,url,{method:'POST',status,body:{messages:history,stream:false}});
 await t.test('Chat uses saved server credentials and defaults without exposing them in its response',async()=>{
  const result=await send();assert.equal(result.model,model.model);assert.equal(result.choices[0].message.content,f.provider.reply);
  assert.deepEqual(result.usage,{prompt_tokens:4,completion_tokens:7,total_tokens:11});
  const call=f.provider.requests.at(-1);assert.equal(call.hasAuthorization,true);assert.equal(call.body.temperature,0.4);assert.equal(call.body.top_p,0.8);assert.equal(call.body.max_tokens,128);
  assert.equal(JSON.stringify(result).includes('qa-chat-provider-key'),false);
 });
 await t.test('A second turn sends the exact prior conversation and accepts bounded incomplete replies',async()=>{
  const history=[...messages,{role:'assistant',content:f.provider.reply},{role:'user',content:'Продолжай'}];
  f.provider.reason='length';const result=await send('main',history);assert.equal(result.choices[0].finish_reason,'length');
  assert.deepEqual(f.provider.requests.at(-1).body.messages,history);f.provider.reason='stop';
 });
 await t.test('A stale semantic pin is rejected before inference, while metadata edits keep the dialogue valid',async()=>{
  const before=f.provider.requests.length;
  await send('main',messages,409,projectRoute+'&expectedModelPin='+'0'.repeat(64));
  await send('main',messages,400,projectRoute+'&expectedModelPin=invalid');
  assert.equal(f.provider.requests.length,before);
  await f.request('main','/api/models/'+model.id,{method:'PATCH',body:{expectedRevision:model.revision,description:'Updated description does not change the selected model.'}});
  await send('main',messages,201,projectRoute+'&expectedModelPin='+model.modelPin);
 });
 await t.test('Developer can use assigned models; observer, anonymous and unrelated scope cannot',async()=>{
  await send('developer');await send('developer',messages,201,route);const before=f.provider.requests.length;
  await send('observer',messages,403);await send(null,messages,401);
  await send('developer',messages,403,route+'?projectId=prj-unrelated');
  const unassigned=await f.request('main','/api/models',{method:'POST',status:201,body:{requestKey:randomUUID(),name:'Unassigned model',runtime:'remote-openai',capability:'chat',model:'unassigned',modelVersion:'1'}});
  await send('developer',messages,403,'/api/models/'+unassigned.id+'/ollama/v1/chat/completions');
  assert.equal(f.provider.requests.length,before);
 });
 await t.test('Remote Ollama uses the same conversation API and preserves native provider parameters',async()=>{
  const card=f.cards[1],result=await send('developer',messages,201,'/api/models/'+card.id+'/ollama/v1/chat/completions?projectId='+f.projectId);
  assert.equal(result.model,card.model);assert.equal(result.choices[0].message.content,f.provider.reply);
  assert.deepEqual(f.provider.requests.at(-1).body.options,{temperature:0.4,top_p:0.8,num_predict:128});
 });
 await t.test('Short conversations beyond forty messages reach the actual provider once without altering their content',async()=>{
  const history=Array.from({length:41},(_,index)=>({role:index%2?'assistant':'user',content:'Short message '+index})),before=f.provider.requests.length;
  const result=await send('main',history);assert.equal(result.choices[0].message.content,f.provider.reply);assert.equal(f.provider.requests.length,before+1);assert.deepEqual(f.provider.requests.at(-1).body.messages,history);
 });
 await t.test('Malformed conversations and embedding models are rejected before inference',async()=>{
  const before=f.provider.requests.length;
  await send('main',[],400);
  await send('main',[{role:'user',content:'x'.repeat(128*1024+1)}],400);
  await send('main',Array.from({length:65},()=>({role:'user',content:'x'.repeat(128*1024)})),400);
  await send('main',messages,400,'/api/models/'+f.cards[2].id+'/ollama/v1/chat/completions?projectId='+f.projectId);
  assert.equal(f.provider.requests.length,before);
 });
 await t.test('Disconnect propagates all the way to the provider; the next explicit request works',async()=>{
  f.provider.mode='hold';const before=f.provider.requests.length,abort=new AbortController();
  const pending=fetch(f.gatewayUrl+projectRoute,{method:'POST',headers:{'content-type':'application/json','x-neurocenter-request':'1',origin:f.base,cookie:f.cookie('main')},body:JSON.stringify({messages,stream:false}),signal:abort.signal});
  const settled=pending.then(()=>null,error=>error);
  await waitFor(()=>f.provider.requests.length>before,'Provider did not receive the request.');const held=f.provider.requests.at(-1);
  abort.abort();assert.ok(await settled);await waitFor(()=>held.closed,'Provider kept running after browser cancellation.');
  assert.equal(f.provider.held.size,0);f.provider.mode='valid';await send();
 });
 await t.test('Provider errors and malformed responses remain recoverable without leaking raw payloads',async()=>{
  for(const mode of ['auth','malformed']){f.provider.mode=mode;const error=await send('main',messages,503);assert.equal(JSON.stringify(error).includes('Synthetic credential rejection.'),false);}
  f.provider.mode='valid';await send();
 });
 await t.test('A newly verified connection cannot silently replace the model selected by an older chat',async()=>{
  let current=await f.request('main','/api/models/'+model.id);const connection=await f.request('main','/api/models/'+model.id+'/connection');
  await f.request('main','/api/models/'+model.id+'/connection',{method:'PUT',body:{expectedRevision:connection.revision,expectedModelRevision:current.revision,
   baseUrl:connection.baseUrl,requestDimensions:false,credential:'stored',options:{temperature:0.6,topP:0.8,maxOutputTokens:128}}});
  current=await f.request('main','/api/models/'+model.id);
  await f.request('main','/api/models/'+model.id+'/hosting',{method:'POST',status:201,body:{action:'check',expectedRevision:current.revision}});
  for(let i=0;i<200;i++){
   const status=await f.request('main','/api/models/'+model.id+'/hosting');
   if(status.state!=='busy'){assert.equal(status.state,'ready',JSON.stringify(status));break;}
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  current=await f.request('main','/api/models/'+model.id);assert.notEqual(current.modelPin,model.modelPin);
  const before=f.provider.requests.length;
  await send('main',messages,409,projectRoute+'&expectedModelPin='+model.modelPin);assert.equal(f.provider.requests.length,before);
  await send('main',messages,201,projectRoute+'&expectedModelPin='+current.modelPin);
 });
 await t.test('A project assignment revoked during a response prevents disclosure of the answer',async()=>{
  f.provider.mode='hold';const before=f.provider.requests.length,pending=send('developer',messages,403);
  await waitFor(()=>f.provider.requests.length>before,'Provider did not receive the permission-change request.');
  await f.request('main','/api/projects/'+f.projectId+'/models/'+model.id,{method:'DELETE'});
  for(const res of f.provider.held){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:model.model,choices:[{index:0,message:{role:'assistant',content:'Private answer'},finish_reason:'stop'}]}));}
  const error=await pending;assert.equal(JSON.stringify(error).includes('Private answer'),false);
  f.provider.mode='valid';assert.deepEqual(f.state.externalCalls,[]);
 });
});
