import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startGroupChatFixture} from './model-chat-group.fixture.mjs';
const adminUrl=process.env.MODEL_CHAT_TEST_ADMIN_URL;
test('Project group chat through actual Gateway/Catalog/RAG, two model protocols and immutable agent settings',{
 skip:!adminUrl?'Set an isolated explicit local MODEL_CHAT_TEST_ADMIN_URL.':false,timeout:180000,
},async t=>{
 const f=await startGroupChatFixture({adminUrl});t.after(()=>f.close());const model=f.cards[0];
 const create=(group=true)=>f.request('main','/api/model-chats',{method:'POST',status:201,body:{modelId:model.id,projectId:f.projectId,expectedModelPin:model.modelPin,...(group?{mode:'group',agentIds:f.agents.map(agent=>agent.id)}:{})}});
 const send=(detail,targets,requestId=randomUUID())=>f.request('main',`/api/model-chats/${detail.conversation.id}/turns`,{method:'POST',status:201,body:{requestId,expectedRevision:detail.conversation.revision,expectedModelPin:model.modelPin,prompt:'Проверьте архитектуру проекта',attachmentIds:[],...(targets===undefined?{}:{targetAgentIds:targets})}});
 await t.test('Normal round returns one attributed answer per participant with their prompt/model and actual sources',async()=>{
  const detail=await create();const roster=await f.request('main',`/api/model-chats/${detail.conversation.id}/agents`);assert.equal(roster.items.length,2);
  const result=await send(detail),turn=result.turns[0];assert.equal(turn.status,'done');assert.equal(turn.responses.length,2);assert.equal(turn.answer,undefined);
  for(const response of turn.responses){assert.equal(response.status,'done');assert.match(response.answer.content,new RegExp(response.name));assert.equal(response.answer.evidence.sources[0].id,'architecture');}
  const calls=f.provider.requests.filter(call=>!call.path.endsWith('/embeddings'));assert.ok(calls.some(call=>call.path.endsWith('/chat/completions')));assert.ok(calls.some(call=>call.path.endsWith('/api/chat')));
 });
 await t.test('Explicit target and idempotent retry cannot accidentally broadcast or call a paid model twice',async()=>{
  const detail=await create(),key=randomUUID(),first=await send(detail,[f.agents[1].id],key),before=f.provider.requests.length;
  assert.equal(first.turns[0].responses.length,1);assert.equal(first.turns[0].responses[0].agentId,f.agents[1].id);
  const repeat=await send(detail,[f.agents[1].id],key);assert.equal(repeat.turns[0].id,first.turns[0].id);assert.equal(f.provider.requests.length,before);
  await f.request('main',`/api/model-chats/${detail.conversation.id}/participants`,{method:'PUT',status:409,body:{expectedRevision:detail.conversation.revision,agentIds:[]}});
 });
 await t.test('Existing project model chat gains agents without losing prior messages or files',async()=>{
  let detail=await create(false);detail=await send(detail);const prior=detail.turns[0],id=detail.conversation.id;
  detail=await f.request('main',`/api/model-chats/${id}/participants`,{method:'PUT',body:{expectedRevision:detail.conversation.revision,agentIds:f.agents.map(agent=>agent.id)}});
  assert.equal(detail.conversation.id,id);assert.equal(detail.conversation.mode,'group');assert.deepEqual(detail.turns[0],prior);
  detail=await send(detail);assert.equal(detail.turns.length,2);assert.equal(detail.turns[1].responses.length,2);
 });
 await t.test('Partial success survives provider failure; retry only requests the failed agent',async()=>{
  const original=f.provider.respond;f.provider.respond=call=>call.path.endsWith('/api/chat')?{mode:'auth'}:original(call);
  let detail=await send(await create()),turn=detail.turns[0];assert.equal(turn.status,'failed');assert.equal(turn.responses.filter(response=>response.status==='done').length,1);
  const saved=turn.responses.find(response=>response.status==='done'),before=f.provider.requests.filter(call=>call.path.endsWith('/chat/completions')).length;
  f.provider.respond=original;
  detail=await f.request('main',`/api/model-chats/${detail.conversation.id}/turns/${turn.id}/retry`,{method:'POST',status:201,body:{expectedRevision:detail.conversation.revision,expectedModelPin:model.modelPin,requestId:randomUUID()}});
  turn=detail.turns[0];assert.equal(turn.status,'done');assert.deepEqual(turn.responses.find(response=>response.id===saved.id),saved);
  assert.equal(f.provider.requests.filter(call=>call.path.endsWith('/chat/completions')).length,before);
 });
 await t.test('Disabled agent remains visible; an explicit live addressee can still answer',async()=>{
  let detail=await create();const updated=await f.request('main','/api/projects/'+f.projectId+'/agents/'+f.agents[1].id,{method:'PATCH',body:{requestKey:randomUUID(),expectedRevision:f.agentRevision(),enabled:false}});f.setAgentRevision(updated.revision);
  detail=await f.request('main',`/api/model-chats/${detail.conversation.id}`);assert.equal(detail.participants[1].status,'disabled');
  const result=await send(detail,[f.agents[0].id]);assert.equal(result.turns[0].status,'done');assert.equal(result.turns[0].responses.length,1);
 });
});
