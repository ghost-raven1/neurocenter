import {randomUUID} from 'node:crypto';
import {startProjectChatFixture} from './model-chat-project.fixture.mjs';

/** Two enabled project agents use actual catalog assignment/version APIs and the existing project index. */
export async function startGroupChatFixture(options){
 const f=await startProjectChatFixture(options);
 try{
  const agents=[];let revision=(await f.request('main','/api/agents?projectId='+f.projectId)).revision??0;
  for(const [name,slug,model]of [['Разработчик','nc-developer',f.cards[0]],['Ревьюер','nc-reviewer',f.cards[1]]]){
   const card=await f.request('main','/api/agents',{method:'POST',status:201,body:{requestKey:randomUUID(),name,slug,definition:{description:name,prompt:'Ты '+name+'. Проверяй данные и объясняй выводы.',mode:'all',permission:{},model:'neurocenter/'+model.id}}});
   let result=await f.request('main','/api/projects/'+f.projectId+'/agents',{method:'POST',status:201,body:{requestKey:randomUUID(),expectedRevision:revision,agentId:card.id,version:card.version,manifest:card.manifest}});revision=result.revision;
   result=await f.request('main','/api/projects/'+f.projectId+'/agents/'+card.id,{method:'PATCH',body:{requestKey:randomUUID(),expectedRevision:revision,enabled:true}});revision=result.revision;agents.push(card);
  }
  f.provider.respond=call=>call.path.endsWith('/embeddings')?undefined:{reply:'Готово: '+(call.body.messages.find(message=>message.role==='system')?.content??'модель')};
  f.provider.requests.length=0;
  return {...f,agents,agentRevision:()=>revision,setAgentRevision:value=>{revision=value;}};
 }catch(error){await f.close();throw error;}
}
