import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {startSkillPackagingFixture} from './skill-packaging.fixture.mjs';

/** Native Gateway/Catalog and an observable local model; all data lives in an owned disposable database. */
export async function startModelChatFixture({adminUrl,browser=false,storageConfig}){
 const requireCatalog=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
 let chatService;
 if(!storageConfig&&process.env.MODEL_CHAT_TEST_STORAGE_CONFIG)storageConfig=JSON.parse(await fs.readFile(process.env.MODEL_CHAT_TEST_STORAGE_CONFIG,'utf8'));
 const f=await startSkillPackagingFixture({adminUrl,browser,configureCatalog:storageConfig?async app=>{
  const {ChatObjectStorage}=requireCatalog('./dist/model-chat/chat-object-storage.js');
  const {ChatAttachmentStorage}=requireCatalog('./dist/model-chat/chat-attachment-storage.js');
  chatService=app.get(requireCatalog('./dist/model-chat/chat.service.js').ModelChatService);
  const config={endpoint:storageConfig.CHAT_S3_ENDPOINT,region:storageConfig.CHAT_S3_REGION,accessKey:storageConfig.CHAT_S3_ACCESS_KEY,secretKey:storageConfig.CHAT_S3_SECRET_KEY,
   projectBucket:storageConfig.CHAT_S3_PROJECT_BUCKET,personalBucket:storageConfig.CHAT_S3_PERSONAL_BUCKET};
  Object.defineProperty(chatService,'storage',{value:new ChatAttachmentStorage(chatService.pool,{objectStorage:new ChatObjectStorage(config,{allowInsecureLocal:true})})});
 }:undefined});
 const provider={mode:'valid',requests:[],held:new Set(),reply:'Готово. **Ответ модели**\n\n```ts\nconst result = 42;\n```',reason:'stop',respond:undefined};
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString()),call={path:req.url,body,hasAuthorization:!!req.headers.authorization,closed:false};
  provider.requests.push(call);res.once('close',()=>{call.closed=true;provider.held.delete(res);});
  const outcome=provider.respond?.(call)||{},mode=outcome.mode||provider.mode,reply=outcome.reply??provider.reply,reason=outcome.reason||provider.reason;
  if(mode==='hold'){provider.held.add(res);return;}
  res.writeHead(mode==='auth'?401:200,{'content-type':'application/json'});
  if(mode==='auth'){res.end(JSON.stringify({error:{message:'Synthetic credential rejection.'}}));return;}
  if(mode==='malformed'){res.end(JSON.stringify({model:body.model,choices:[]}));return;}
  if(req.url.endsWith('/embeddings'))res.end(JSON.stringify({object:'list',model:body.model,data:body.input.map((_,index)=>({object:'embedding',index,embedding:[1,index+1,3]}))}));
  else if(req.url.endsWith('/chat/completions'))res.end(JSON.stringify({model:body.model,choices:[{index:0,message:{role:'assistant',content:reply},finish_reason:reason}],usage:{prompt_tokens:4,completion_tokens:7,total_tokens:11}}));
  else res.end(JSON.stringify({model:body.model,message:{role:'assistant',content:reply},done:true,done_reason:reason,prompt_eval_count:4,eval_count:7}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const endpoint='http://127.0.0.1:'+server.address().port;
 const close=async()=>{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  try{if(chatService){await f.pool.query('DELETE FROM model_chat_conversations');await chatService.storage.collect(1000);}}finally{await f.close();}
 };
 try{
  const cards=[];
  for(const [name,runtime,capability]of [['Диалоговая модель','remote-openai','chat'],['Ollama для диалога','remote-ollama','chat'],['Поиск по смыслу','remote-openai','embedding']]){
   let card=await f.request('main','/api/models',{method:'POST',status:201,body:{requestKey:randomUUID(),name,runtime,capability,model:'qa-chat-'+cards.length,modelVersion:'1',...(capability==='embedding'?{dimension:3}:{})}});
   await f.request('main','/api/models/'+card.id+'/connection',{method:'PUT',body:{expectedRevision:0,expectedModelRevision:card.revision,baseUrl:endpoint+(runtime==='remote-openai'?'/v1':''),
    requestDimensions:false,credential:runtime==='remote-openai'?'stored':'none',...(runtime==='remote-openai'?{apiKey:'qa-chat-provider-key'}:{}),
    options:capability==='embedding'?{}:{temperature:0.4,topP:0.8,maxOutputTokens:128}}});
   card=await f.request('main','/api/models/'+card.id);
   await f.request('main','/api/models/'+card.id+'/hosting',{method:'POST',status:201,body:{action:'check',expectedRevision:card.revision}});
   let ready=false;for(let i=0;i<200;i++){
    const status=await f.request('main','/api/models/'+card.id+'/hosting');
    if(status.state!=='busy'){assert.equal(status.state,'ready',JSON.stringify(status));ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   assert.ok(ready,'Fixture model verification completed.');
   card=await f.request('main','/api/models/'+card.id);cards.push(card);
   await f.request('main','/api/projects/'+f.projectId+'/models',{method:'POST',status:201,body:{modelId:card.id}});
  }
  f.actors.observer={email:'observer@chat.example.test',role:'Наблюдатель'};
  await f.pool.query('INSERT INTO platform_users(email,display_name,is_main_admin) VALUES($1,$2,false)',[f.actors.observer.email,'QA observer']);
  await f.pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)',[f.projectId,f.actors.observer.email,'Наблюдатель']);
  provider.requests.length=0;
  return {...f,provider,endpoint,cards,close};
 }catch(error){await close();throw error;}
}
