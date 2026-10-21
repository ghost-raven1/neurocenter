import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startModelChatFixture} from './model-chat.fixture.mjs';

const adminUrl=process.env.MODEL_USAGE_TEST_ADMIN_URL;
const waitFor=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Usage condition was not reached.');};
test('Actual model usage through Gateway/Catalog and observable providers',{
 skip:!adminUrl?'Set MODEL_USAGE_TEST_ADMIN_URL to an isolated PostgreSQL port.':false,timeout:120000,
},async t=>{
 const f=await startModelChatFixture({adminUrl});t.after(()=>f.close());const model=f.cards[0],base='/api/model-usage';
 const report=(actor='main',filter='')=>f.request(actor,base+filter);
 const create=(extra={})=>f.request('developer','/api/model-chats',{method:'POST',status:201,body:{modelId:model.id,projectId:f.projectId,expectedModelPin:model.modelPin,...extra}});
 const body=(chat,prompt='private-user-prompt',requestId=randomUUID())=>({requestId,prompt,attachmentIds:[],expectedRevision:chat.conversation.revision,expectedModelPin:model.modelPin});
 const send=(chat,input)=>f.request('developer',`/api/model-chats/${chat.conversation.id}/turns`,{method:'POST',status:201,body:input});
 await t.test('Startup verification is counted as actual model work without provider URLs or credentials',async()=>{
  const result=await report();assert.equal(result.summary.requests,3);assert.equal(result.summary.success,3);assert.equal(result.byPurpose[0].purpose,'verification');
  assert.equal(result.items.filter(item=>item.provider==='remote-openai').length,2);assert.ok(result.items.every(item=>item.actorEmail===f.actors.main.email&&item.operationId));
  const embed=result.items.find(item=>item.endpoint==='embed');assert.equal(embed.inputTokens,null);assert.equal(embed.outputTokens,null);
  assert.doesNotMatch(JSON.stringify(result),/qa-chat-provider-key|127\.0\.0\.1|private-user-prompt|private-provider-answer/);
  assert.equal((await report('developer')).summary.requests,0);
 });
 await t.test('One paid turn has one UUID receipt; duplicate browser submission never counts twice',async()=>{
  let chat=await create();const input=body(chat),before=f.provider.requests.length;
  f.provider.reply='private-provider-answer';chat=await send(chat,input);assert.equal(chat.turns[0].status,'done');await send(chat,input);
  assert.equal(f.provider.requests.length,before+1);const result=await report('developer','?purpose=chat');assert.equal(result.items.length,1);
  assert.deepEqual(result.summary.inputTokens,'4');assert.deepEqual(result.summary.outputTokens,'7');assert.equal(result.items[0].turnId,chat.turns[0].id);
  assert.equal(result.items[0].projectId,f.projectId);assert.equal(result.items[0].status,'success');assert.ok(result.items[0].latencyMs>=0);
  assert.doesNotMatch(JSON.stringify(result),/private-user-prompt|private-provider-answer|qa-chat-provider-key/);
 });
 await t.test('Embedding without a provider counter remains unknown in the real API',async()=>{
  const embedding=f.cards[2];await f.request('developer',`/api/models/${embedding.id}/ollama/api/embed?projectId=${f.projectId}`,{method:'POST',status:201,body:{input:['private embedding document']}});
  const result=await report('developer','?purpose=direct');assert.equal(result.summary.requests,1);assert.equal(result.summary.inputTokens,null);assert.equal(result.summary.unknownInputRequests,1);
  assert.equal(result.items[0].endpoint,'embed');assert.equal(result.items[0].projectId,f.projectId);
 });
 await t.test('Provider errors are counted while private failure bodies never appear in the ledger',async()=>{
  const chat=await create();f.provider.mode='auth';const result=await send(chat,body(chat));assert.equal(result.turns[0].status,'failed');
  f.provider.mode='valid';const errors=await report('developer','?status=error');assert.equal(errors.summary.requests,1);assert.equal(errors.items[0].purpose,'chat');
  assert.doesNotMatch(JSON.stringify(errors),/Synthetic credential|qa-chat-provider-key|private-user-prompt/);
 });
 await t.test('A project agent response retains its own model, agent and turn attribution',async()=>{
  const agent=await f.request('main','/api/agents',{method:'POST',status:201,body:{requestKey:randomUUID(),name:'QA usage agent',slug:'nc-qa-usage-agent',definition:{description:'QA usage',prompt:'private agent prompt',mode:'all',permission:{},model:'neurocenter/'+model.id}}});
  const current=await f.request('main','/api/agents?projectId='+f.projectId);
  let assignment=await f.request('main',`/api/projects/${f.projectId}/agents`,{method:'POST',status:201,body:{requestKey:randomUUID(),expectedRevision:current.revision,agentId:agent.id,version:agent.version,manifest:agent.manifest}});
  await f.request('main',`/api/projects/${f.projectId}/agents/${agent.id}`,{method:'PATCH',body:{requestKey:randomUUID(),expectedRevision:assignment.revision,enabled:true}});
  const chat=await create({mode:'group',agentIds:[agent.id]}),result=await send(chat,body(chat));assert.equal(result.turns[0].status,'done');
  const usage=await report('developer','?purpose=agent');assert.equal(usage.items.length,1);assert.equal(usage.items[0].agentId,agent.id);assert.equal(usage.items[0].turnId,result.turns[0].id);assert.equal(usage.items[0].modelId,model.id);
  assert.doesNotMatch(JSON.stringify(usage),/private agent prompt/);
 });
 await t.test('Pending work is observable and explicit cancel aborts upstream with a terminal receipt',async()=>{
  const chat=await create();f.provider.mode='hold';const pending=send(chat,body(chat));await waitFor(()=>f.provider.held.size===1);
  const running=await report('developer','?status=pending');assert.equal(running.items.length,1);assert.equal(running.items[0].inputTokens,null);
  const active=await f.request('developer',`/api/model-chats/${chat.conversation.id}`),turn=active.turns[0];
  await f.request('developer',`/api/model-chats/${chat.conversation.id}/turns/${turn.id}/cancel`,{method:'POST',status:201,body:{expectedRevision:active.conversation.revision}});
  await pending;await waitFor(()=>f.provider.held.size===0);f.provider.mode='valid';
  const cancelled=await report('developer','?status=cancelled');assert.equal(cancelled.items.length,1);assert.equal(cancelled.items[0].turnId,turn.id);
 });
 await t.test('Current roles and project grants protect each report page, including personal calls',async()=>{
  f.actors.projectAdmin={email:'usage-admin@example.test',role:'Админ проекта'};
  await f.pool.query('INSERT INTO platform_users(email,display_name) VALUES($1,$1)',[f.actors.projectAdmin.email]);
  await f.pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)',[f.projectId,f.actors.projectAdmin.email,'Админ проекта']);
  const all=await report(),project=await report('projectAdmin'),own=await report('developer');
  assert.equal(all.summary.requests,own.summary.requests+3);assert.equal(project.summary.requests,own.summary.requests);
  assert.ok(project.items.every(item=>item.projectId===f.projectId));await f.request('observer',base,{status:403});await f.request(null,base,{status:401});
  const ids=[],pageSize=2;let page=await report('developer','?limit='+pageSize);
  while(true){ids.push(...page.items.map(item=>item.id));if(!page.history.hasMore)break;page=await report('developer','?limit='+pageSize+'&cursor='+encodeURIComponent(page.history.nextCursor));}
  assert.equal(new Set(ids).size,own.summary.requests);assert.equal(ids.length,own.summary.requests);
  // Keep the developer role valid in another project; only access to this project's history is revoked.
  await f.pool.query("INSERT INTO projects(id,name) VALUES('prj-usage-other','Usage other project')");
  await f.pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)',['prj-usage-other',f.actors.developer.email,'Разработчик']);
  await f.pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[f.projectId,f.actors.developer.email]);
  assert.equal((await report('developer')).summary.requests,0);assert.equal((await report('projectAdmin')).summary.requests,project.summary.requests);
 });
 await t.test('Malformed filters and write verbs never pass the declared read-only API',async()=>{
  for(const query of ['?days=2','?limit=10000','?status=unknown','?purpose=private','?cursor=wrong','?apiKey=secret'])await f.request('main',base+query,{status:400});
  await f.request('main',base,{method:'POST',status:403,body:{}});
  const stored=(await f.pool.query('SELECT to_jsonb(u) AS row FROM model_usage_calls u')).rows;
  assert.doesNotMatch(JSON.stringify(stored),/private-user-prompt|private-provider-answer|qa-chat-provider-key|Synthetic credential/);
 });
});
