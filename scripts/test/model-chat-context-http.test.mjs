import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {startModelChatFixture} from './model-chat.fixture.mjs';

const requireCatalog=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const adminUrl=process.env.MODEL_CHAT_CONTEXT_TEST_ADMIN_URL;
const waitFor=async check=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Expected bounded chat processing state.');};

test('Automatic compaction and paged original history through real Gateway/Catalog',{
 skip:!adminUrl?'Set MODEL_CHAT_CONTEXT_TEST_ADMIN_URL to an owned disposable PostgreSQL instance.':false,timeout:180000,
},async t=>{
 const f=await startModelChatFixture({adminUrl});t.after(()=>f.close());
 const {COMPACTION_INSTRUCTION}=requireCatalog('./dist/model-chat/chat-compaction.js');
 const summary=call=>call.body.messages?.[0]?.content===COMPACTION_INSTRUCTION;
 f.provider.respond=call=>summary(call)?{reply:'Сводка: цель — проверить проект. Решение — сохранить полную историю. Неопределённости отмечены.'}:undefined;
 let card=f.cards[1];const connection=await f.request('main','/api/models/'+card.id+'/connection');
 await f.request('main','/api/models/'+card.id+'/connection',{method:'PUT',body:{expectedRevision:connection.revision,expectedModelRevision:card.revision,
  baseUrl:connection.baseUrl,requestDimensions:false,credential:'none',options:{temperature:0.4,topP:0.8,maxOutputTokens:128,contextWindow:4096}}});
 card=await f.request('main','/api/models/'+card.id);
 await f.request('main','/api/models/'+card.id+'/hosting',{method:'POST',status:201,body:{action:'check',expectedRevision:card.revision}});
 await waitFor(async()=>{const state=await f.request('main','/api/models/'+card.id+'/hosting');if(state.state==='busy')return false;assert.equal(state.state,'ready');return true;});
 card=await f.request('main','/api/models/'+card.id);f.provider.requests.length=0;
 const base='/api/model-chats',route=detail=>base+'/'+detail.conversation.id;
 const create=async(model=card)=>f.request('developer',base,{method:'POST',status:201,body:{modelId:model.id,projectId:f.projectId,expectedModelPin:model.modelPin}});
 const read=detail=>f.request('developer',route(detail));
 const body=(detail,prompt='Продолжай проверку',model=card)=>({expectedRevision:detail.conversation.revision,requestId:randomUUID(),expectedModelPin:model.modelPin,prompt,attachmentIds:[]});
 const send=(detail,input,status=201)=>f.request('developer',route(detail)+'/turns',{method:'POST',status,body:input});
 const seed=async(detail,count=8,bytes=1000)=>{
  for(let i=0;i<count;i++)await f.pool.query(`INSERT INTO model_chat_turns(id,conversation_id,request_id,request_ids,request_hash,prompt,attachment_ids,input_text,status,answer)
   VALUES($1,$2,$3,ARRAY[$3::uuid],$4,$5,'{}',$5,'done',$6::jsonb)`,[randomUUID(),detail.conversation.id,randomUUID(),'a'.repeat(64),'Факт '+i+' '+('x'.repeat(Math.min(bytes,1000))),JSON.stringify({content:'Ответ '+i+' '+('y'.repeat(bytes)),finishReason:'stop',usage:{reported:false,inputTokens:null,outputTokens:null,totalTokens:null}})]);
  return read(detail);
 };
 const originals=async detail=>(await f.pool.query("SELECT id,input_text,answer FROM model_chat_turns WHERE conversation_id=$1 AND status='done' ORDER BY position",[detail.conversation.id])).rows;
 const digest=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
 const checkpointCount=async detail=>Number((await f.pool.query('SELECT count(*) AS n FROM model_chat_compactions WHERE conversation_id=$1',[detail.conversation.id])).rows[0].n);

 await t.test('Preview is free, compaction preserves originals, and duplicate request IDs do not repeat model work',async()=>{
  let detail=await seed(await create());const original=await originals(detail),before=f.provider.requests.length;
  const preview=await f.request('developer',route(detail)+'/context-preview',{method:'POST',status:201,body:{prompt:'Продолжай',attachmentIds:[]}});
  assert.equal(preview.compactionNeeded,true);assert.equal(preview.canCompact,true);assert.equal(preview.exceeded,false);assert.equal(f.provider.requests.length,before);
  const input=body(detail);detail=await send(detail,input);assert.equal(detail.turns.at(-1).status,'done');
  const calls=f.provider.requests.slice(before);assert.ok(calls.some(summary));assert.equal(summary(calls.at(-1)),false);
  assert.ok(calls.at(-1).body.messages.some(message=>message.content.startsWith('Резюме ранней части')));
  assert.ok(calls.at(-1).body.messages.every(message=>message.role!=='system'),'Generated summary is data, not a system instruction.');
  assert.equal(digest((await originals(detail)).slice(0,original.length)),digest(original));assert.ok(await checkpointCount(detail)>0);
  const after=f.provider.requests.length;await send(detail,input);assert.equal(f.provider.requests.length,after);
  const loaded=await read(detail);assert.equal(loaded.compaction.state,'ready');assert.ok(loaded.compaction.coveredTurns>0);
 });

 await t.test('An accepted checkpoint is reused after failure of the final model response',async()=>{
  let detail=await seed(await create());
  f.provider.respond=call=>summary(call)?{reply:'Краткая сводка предыдущих фактов.'}:{mode:'auth'};
  detail=await send(detail,body(detail));assert.equal(detail.turns.at(-1).status,'failed');const count=await checkpointCount(detail);assert.ok(count>0);
  const before=f.provider.requests.length;f.provider.respond=call=>summary(call)?{reply:'Повторная сводка не требуется.'}:undefined;
  detail=await f.request('developer',route(detail)+'/turns/'+detail.turns.at(-1).id+'/retry',{method:'POST',status:201,body:{expectedRevision:detail.conversation.revision,requestId:randomUUID(),expectedModelPin:card.modelPin}});
  assert.equal(detail.turns.at(-1).status,'done');assert.ok(f.provider.requests.slice(before).every(call=>!summary(call)));assert.equal(await checkpointCount(detail),count);
 });

 await t.test('Empty or truncated summaries never replace saved history or start the main request',async()=>{
  for(const response of [{reply:''},{reply:'Неполное резюме',reason:'length'}]){
   let detail=await seed(await create());const before=digest(await originals(detail)),start=f.provider.requests.length;
   f.provider.respond=call=>summary(call)?response:undefined;
   detail=await send(detail,body(detail));assert.equal(detail.turns.at(-1).status,'failed');assert.equal(await checkpointCount(detail),0);
   assert.equal(digest(await originals(detail)),before);assert.ok(f.provider.requests.slice(start).every(summary));
  }
 });

 await t.test('A bounded compaction saves partial progress and retries continue instead of restarting',async()=>{
  let detail=await seed(await create(),1,100000);const original=digest(await originals(detail)),start=f.provider.requests.length;
  f.provider.respond=call=>summary(call)?{reply:'Краткая сводка фактов.'}:undefined;
  detail=await send(detail,body(detail));assert.equal(detail.turns.at(-1).status,'failed');assert.match(detail.turns.at(-1).error,/прогресс|восьми/);
  assert.equal(f.provider.requests.slice(start).filter(summary).length,8);assert.equal(await checkpointCount(detail),8);
  const offset=async()=>Number((await f.pool.query('SELECT through_offset FROM model_chat_compactions WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[detail.conversation.id])).rows[0].through_offset);
  const first=await offset();
  detail=await f.request('developer',route(detail)+'/turns/'+detail.turns.at(-1).id+'/retry',{method:'POST',status:201,body:{expectedRevision:detail.conversation.revision,requestId:randomUUID(),expectedModelPin:card.modelPin}});
  assert.ok(await offset()>first);assert.ok(await checkpointCount(detail)>8);assert.equal(digest(await originals(detail)),original);
 });

 await t.test('Cancel during compaction aborts the upstream call and prevents a late checkpoint or answer',async()=>{
  let detail=await seed(await create());const start=f.provider.requests.length;
  f.provider.respond=call=>summary(call)?{mode:'hold'}:undefined;const pending=send(detail,body(detail));
  await waitFor(()=>f.provider.requests.length>start);const call=f.provider.requests.at(-1);assert.ok(summary(call));
  detail=await read(detail);assert.equal(detail.turns.at(-1).processingStage,'compacting');
  detail=await f.request('developer',route(detail)+'/turns/'+detail.turns.at(-1).id+'/cancel',{method:'POST',status:201,body:{expectedRevision:detail.conversation.revision}});
  await pending;await waitFor(()=>call.closed);assert.equal((await read(detail)).turns.at(-1).status,'cancelled');assert.equal(await checkpointCount(detail),0);
  assert.equal(f.provider.requests.length,start+1);
 });

 await t.test('Disabling inference preserves the paid checkpoint and blocks every subsequent inference while reads remain available',async()=>{
  let detail=await seed(await create());const start=f.provider.requests.length;
  f.provider.respond=call=>summary(call)?{mode:'hold'}:undefined;const pending=send(detail,body(detail),403);
  await waitFor(()=>f.provider.held.size>0);f.state.modelHostingEnabled=false;
  const call=f.provider.requests.at(-1);for(const res of [...f.provider.held]){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:call.body.model,message:{role:'assistant',content:'Сводка.'},done:true,done_reason:'stop'}));}
  try{await pending;detail=await read(detail);assert.equal(detail.turns.at(-1).status,'failed');assert.equal(await checkpointCount(detail),1);assert.equal(f.provider.requests.length,start+1);assert.equal(detail.turns.at(-1).answer,undefined);assert.ok(f.provider.requests.slice(start).every(summary),'No final or second compaction request can start after off.');}
  finally{f.state.modelHostingEnabled=true;}
 });

 await t.test('A model pin changed during summarization prevents a late checkpoint and final request',async()=>{
  let detail=await seed(await create());const start=f.provider.requests.length;
  f.provider.respond=call=>summary(call)?{mode:'hold'}:undefined;const pending=send(detail,body(detail),409);
  await waitFor(()=>f.provider.held.size>0);const call=f.provider.requests.at(-1);
  await f.pool.query("UPDATE model_catalog SET descriptor=jsonb_set(descriptor,'{verificationSha256}',$2::jsonb) WHERE id=$1",[card.id,JSON.stringify('e'.repeat(64))]);
  for(const res of [...f.provider.held]){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:call.body.model,message:{role:'assistant',content:'Не сохранять.'},done:true,done_reason:'stop'}));}
  try{await pending;assert.equal(await checkpointCount(detail),0);assert.equal(f.provider.requests.length,start+1);assert.ok((await read(detail)).blockedReason);}
  finally{await f.pool.query("UPDATE model_catalog SET descriptor=jsonb_set(descriptor,'{verificationSha256}',$2::jsonb) WHERE id=$1",[card.id,JSON.stringify(card.verificationSha256)]);}
 });

 await t.test('A new prompt larger than the configured window is rejected without summarizing older history',async()=>{
  let detail=await seed(await create());const before=f.provider.requests.length;
  const prompt='z'.repeat(9000),preview=await f.request('developer',route(detail)+'/context-preview',{method:'POST',status:201,body:{prompt,attachmentIds:[]}});
  assert.equal(preview.exceeded,true);assert.equal(preview.canCompact,false);await send(detail,body(detail,prompt),400);assert.equal(f.provider.requests.length,before);
 });

 await t.test('Paged history is stable, private, complete and independent of the inference projection',async()=>{
  const detail=await seed(await create(f.cards[0]),123,10),seen=[];let page={turns:detail.turns,history:detail.history};
  assert.ok(page.turns.length<=50);assert.equal(page.history.hasMore,true);
  while(true){seen.unshift(...page.turns.map(turn=>turn.id));if(!page.history.hasMore)break;
   assert.ok(page.history.nextCursor);page=await f.request('developer',route(detail)+'/history?before='+page.history.nextCursor+'&limit=50');}
  assert.equal(seen.length,123);assert.equal(new Set(seen).size,123);
  const source=await originals(detail);assert.deepEqual(seen,source.map(row=>row.id));
  await f.request('main',route(detail)+'/history?before='+seen.at(-1),{status:404});
  await f.request('developer',route(detail)+'/history?before=bad',{status:400});
  await f.request('developer',route(detail)+'/history?before='+seen.at(-1)+'&limit=100000',{status:400});
  const other=await seed(await create(f.cards[0]),1,10);
  await f.request('developer',route(other)+'/history?before='+seen.at(-1),{status:404});
 });

 await t.test('History pages remain below Gateway response bounds for large individual saved answers',async()=>{
  const detail=await seed(await create(f.cards[0]),5,2*1024*1024);let page={turns:detail.turns,history:detail.history},count=0;
  while(true){assert.ok(Buffer.byteLength(JSON.stringify(page))<16*1024*1024);count+=page.turns.length;if(!page.history.hasMore)break;
   page=await f.request('developer',route(detail)+'/history?before='+page.history.nextCursor+'&limit=50');}
  assert.equal(count,5);
 });

 await t.test('Previously saved highly escaped answers remain readable without truncating originals',async()=>{
  let detail=await create(f.cards[0]);const content='\n'.repeat(8*1024*1024-1024),id=randomUUID(),requestId=randomUUID();
  await f.pool.query(`INSERT INTO model_chat_turns(id,conversation_id,request_id,request_ids,request_hash,prompt,attachment_ids,input_text,status,answer)
   VALUES($1,$2,$3,ARRAY[$3::uuid],$4,'Historical answer','{}','Historical answer','done',$5::jsonb)`,[id,detail.conversation.id,requestId,'b'.repeat(64),JSON.stringify({content,finishReason:'stop',usage:{reported:false,inputTokens:null,outputTokens:null,totalTokens:null}})]);
  detail=await read(detail);assert.equal(detail.turns[0].answer.content,content);assert.equal(detail.turns[0].id,id);
 });
});
