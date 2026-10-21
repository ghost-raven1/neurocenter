import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startProjectChatFixture} from './model-chat-project.fixture.mjs';
const adminUrl=process.env.MODEL_CHAT_TEST_ADMIN_URL;
test('Project chat retrieves real pgvector sources via internal RAG HTTP with live authorization',{
 skip:!adminUrl?'Set an isolated explicit local MODEL_CHAT_TEST_ADMIN_URL.':false,timeout:180000,
},async t=>{
 const f=await startProjectChatFixture({adminUrl});t.after(()=>f.close());
 const create=()=>f.request('main','/api/model-chats',{method:'POST',status:201,body:{modelId:f.cards[0].id,projectId:f.projectId,expectedModelPin:f.cards[0].modelPin}});
 const send=(detail,prompt='Как устроен проект?',status=201)=>f.request('main',`/api/model-chats/${detail.conversation.id}/turns`,{method:'POST',status,body:{expectedRevision:detail.conversation.revision,requestId:randomUUID(),expectedModelPin:f.cards[0].modelPin,prompt,attachmentIds:[]}});
 await t.test('Read/preview do not call a model; successful replies include exact used project sources',async()=>{
  const detail=await create();assert.equal(detail.projectContext.status,'ready');assert.equal(f.provider.requests.length,0);
  await f.request('main',`/api/model-chats/${detail.conversation.id}/context-preview`,{method:'POST',status:201,body:{prompt:'Проект',attachmentIds:[]}});assert.equal(f.provider.requests.length,0);
  const answer=await send(detail),turn=answer.turns[0];assert.equal(turn.status,'done');assert.equal(turn.answer.evidence.status,'ready');
  assert.deepEqual(turn.answer.evidence.sources.map(s=>s.id),['architecture']);
  assert.match(f.provider.requests.find(call=>call.path.endsWith('/chat/completions')).body.messages[0].content,/PostgreSQL.*API Gateway/);
  assert.equal(f.provider.requests.filter(call=>call.path.endsWith('/embeddings')).length,1);
  const saved=(await f.pool.query('SELECT input_text FROM model_chat_turns WHERE id=$1',[turn.id])).rows[0].input_text;
  assert.equal(saved,'Как устроен проект?','Retrieval documents must never become permanent compaction inputs.');
  assert.doesNotMatch(JSON.stringify(answer),/qa-chat-provider-key/);
 });
 await t.test('Missing external/internal permission never discloses project sources',async()=>{
  const detail=await create(),before=f.provider.requests.length;
  await f.request('observer',`/api/model-chats/${detail.conversation.id}`,{status:403});
  const response=await fetch(f.ragUrl+'/internal/project-rag/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:f.projectId})});assert.equal(response.status,403);
  assert.equal(f.provider.requests.length,before);
 });
 await t.test('Unfinished index fails explicitly without a fabricated model response',async()=>{
  const detail=await create();await f.pool.query('UPDATE project_embedding_settings SET active_snapshot=NULL,data_revision=data_revision+1 WHERE project_id=$1',[f.projectId]);
  try{f.provider.requests.length=0;const result=await send(detail,'Проект?',409);assert.match(result.message,/индекс|синхрон/i);
   const saved=await f.request('main',`/api/model-chats/${detail.conversation.id}`);assert.equal(saved.turns[0].status,'failed');assert.equal(f.provider.requests.length,0);
  }finally{await f.pool.query('UPDATE project_embedding_settings SET active_snapshot=$2,data_revision=data_revision+1 WHERE project_id=$1',[f.projectId,f.snapshot]);}
 });
 await t.test('A generation change during embedding discards the stale query before final inference',async()=>{
  const detail=await create();let changed=false,write;
  f.provider.respond=call=>{if(call.path.endsWith('/embeddings')&&!changed){changed=true;write=f.pool.query('UPDATE project_embedding_settings SET data_revision=data_revision+1 WHERE project_id=$1',[f.projectId]);return {mode:'hold'};}};
  const pending=send(detail,'Проект?',409);for(let i=0;i<200&&!changed;i++)await new Promise(r=>setTimeout(r,10));assert.ok(changed);
  await write;for(const response of f.provider.held){response.setHeader('content-type','application/json');response.end(JSON.stringify({object:'list',model:f.cards[2].model,data:[{object:'embedding',index:0,embedding:[1,1,3]}]}));}
  const result=await pending;assert.match(result.message,/Контекст проекта|индекс/i);
  const saved=await f.request('main',`/api/model-chats/${detail.conversation.id}`);assert.equal(saved.turns[0].status,'failed');
  f.provider.respond=undefined;
 });
});
