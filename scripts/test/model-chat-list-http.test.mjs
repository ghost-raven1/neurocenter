import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startModelChatFixture} from './model-chat.fixture.mjs';
const adminUrl=process.env.MODEL_CHAT_LIST_TEST_ADMIN_URL;
test('Global chat lists personal dialogues across models within one explicit project scope',{
 skip:!adminUrl?'Set isolated MODEL_CHAT_LIST_TEST_ADMIN_URL.':false,timeout:120000,
},async t=>{
 const f=await startModelChatFixture({adminUrl});t.after(()=>f.close());const base='/api/model-chats';
 const create=(actor,index,projectId)=>{const model=f.cards[index];return f.request(actor,base,{method:'POST',status:201,body:{modelId:model.id,expectedModelPin:model.modelPin,...(projectId?{projectId}:{})}});};
 const projectChats=await Promise.all([create('developer',0,f.projectId),create('developer',1,f.projectId)]);
 const commonChats=await Promise.all([create('developer',0),create('developer',1)]);
 const otherOwner=await create('main',0,f.projectId);
 await t.test('Project list spans models, never includes common conversations or another owner',async()=>{
  const result=await f.request('developer',base+'?projectId='+f.projectId);assert.deepEqual(new Set(result.items.map(item=>item.id)),new Set(projectChats.map(item=>item.conversation.id)));
  assert.equal(result.items.some(item=>item.id===otherOwner.conversation.id),false);assert.ok(result.items.every(item=>item.projectId===f.projectId));
  const main=await f.request('main',base+'?projectId='+f.projectId);assert.deepEqual(main.items.map(item=>item.id),[otherOwner.conversation.id]);
 });
 await t.test('Omitted project means only project-null personal conversations across models',async()=>{
  const result=await f.request('developer',base);assert.deepEqual(new Set(result.items.map(item=>item.id)),new Set(commonChats.map(item=>item.conversation.id)));assert.ok(result.items.every(item=>item.projectId===null));
 });
 await t.test('Existing explicit model filter preserves its narrower contract',async()=>{
  const result=await f.request('developer',base+`?modelId=${f.cards[0].id}&projectId=${f.projectId}`);assert.deepEqual(result.items.map(item=>item.id),[projectChats[0].conversation.id]);
  const common=await f.request('developer',base+'?modelId='+f.cards[1].id);assert.deepEqual(common.items.map(item=>item.id),[commonChats[1].conversation.id]);
 });
 await t.test('Revoked model assignment removes only its inaccessible dialogues from aggregate lists',async()=>{
  await f.request('main',`/api/projects/${f.projectId}/models/${f.cards[1].id}`,{method:'DELETE'});
  const result=await f.request('developer',base+'?projectId='+f.projectId);assert.deepEqual(result.items.map(item=>item.id),[projectChats[0].conversation.id]);
  await f.request('developer',base+`?modelId=${f.cards[1].id}&projectId=${f.projectId}`,{status:403});
  await f.request('developer',base+'/'+projectChats[1].conversation.id,{status:403});
  const common=await f.request('developer',base);assert.deepEqual(common.items.map(item=>item.id),[commonChats[0].conversation.id]);
 });
 await t.test('Observers, anonymous users, invalid models and foreign projects cannot enumerate conversations',async()=>{
  await f.request('observer',base,{status:403});await f.request(null,base,{status:401});await f.request('developer',base+'?projectId=prj-foreign',{status:403});await f.request('developer',base+'?modelId=',{status:400});
  assert.equal(f.provider.requests.length,0,'Listing never calls a model.');
 });
});
