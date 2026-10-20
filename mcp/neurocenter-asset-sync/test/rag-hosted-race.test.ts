import {afterEach,expect,it,vi} from 'vitest';
import {createHostedRelay,inferHosted} from '../src/features/rag-hosted/relay.js';
import {requestProfile,type HostedProfile} from '../src/features/rag-hosted/profile.js';
const state=vi.hoisted(()=>({assert:vi.fn()}));
vi.mock('../src/features/rag-hosted/profile.js',async importOriginal=>({...await importOriginal<object>(),assertHostedInstallation:state.assert}));
vi.mock('../src/bridge/state.js',()=>({hub:()=> 'http://broker.fixture',readState:async()=>({token:'synthetic-device-key'})}));
const nativeFetch=globalThis.fetch;
afterEach(()=>vi.unstubAllGlobals());
function selection(revision:number,pin:string){return {revision,modelPin:pin,profile:{provider:'openai' as const,model:'neurocenter/model-fixture/sha256/'+pin,dimension:3},model:null};}
function profile():HostedProfile{return {schemaVersion:2,server:'http://broker.fixture',root:'/synthetic',projectId:'fixture',bindingId:'binding',instanceId:'instance',grants:[{pkg:{manifest:{sha256:'e'.repeat(64)},plugin:{kind:'mcp',id:'fixture-rag',version:9}} as never,selection:selection(1,'a'.repeat(64)),key:'d'.repeat(64)}],relay:{port:0}};}
function gate(){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});const pending=new Promise<void>(resolve=>{release=resolve;});state.assert.mockImplementation(async()=>{enter();await pending;});return {entered,release};}
function broker(){const sent:Array<Record<string,unknown>>=[];vi.stubGlobal('fetch',vi.fn(async(_url:unknown,options:RequestInit)=>{const body=JSON.parse(String(options.body));sent.push(body);return Response.json({model:body.model,data:[{index:0,embedding:[1,2,3]}]});}));return sent;}
it('Смена live-профиля на await отклоняет ответ старому клиенту и никогда не подставляет новую модель',async()=>{
 const waiting=gate(),sent=broker(),first=profile(),relay=await createHostedRelay(first);
 try{const request=nativeFetch(`http://127.0.0.1:${first.relay.port}/v1/embeddings`,{method:'POST',headers:{authorization:'Bearer '+first.grants[0]!.key},body:JSON.stringify({model:first.grants[0]!.selection.profile.model,input:'request-A'})});
  await waiting.entered;relay.profile={...first,grants:[{...first.grants[0]!,selection:selection(2,'b'.repeat(64))}]};waiting.release();const response=await request;
  expect(response.status).toBe(409);expect(sent[0]?.model).toBe(first.grants[0]!.selection.profile.model);expect(sent[0]?.expectedRevision).toBe(1);
 }finally{waiting.release();await relay.close();}
});
it('Порядок ключей равного профиля после reconnect не отменяет выполняющийся запрос',async()=>{
 const waiting=gate(),sent=broker(),first=profile(),relay=await createHostedRelay(first);
 try{const request=nativeFetch(`http://127.0.0.1:${first.relay.port}/v1/embeddings`,{method:'POST',headers:{authorization:'Bearer '+first.grants[0]!.key},body:JSON.stringify({model:first.grants[0]!.selection.profile.model,input:'request-A'})});
  await waiting.entered;const grant=relay.profile.grants[0]!,before=grant.selection.profile;
  grant.selection={...grant.selection,profile:{model:before.model,dimension:before.dimension,provider:before.provider}};
  waiting.release();const response=await request;
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({model:before.model});expect(sent).toHaveLength(1);expect(sent[0]?.expectedRevision).toBe(1);
 }finally{waiting.release();await relay.close();}
});
it.each<{name:string;change:(live:HostedProfile)=>void}>([
 {name:'server',change:live=>{live.server='http://other.fixture';}},
 {name:'root',change:live=>{live.root='/other';}},
 {name:'projectId',change:live=>{live.projectId='other';}},
 {name:'bindingId',change:live=>{live.bindingId='other';}},
 {name:'instanceId',change:live=>{live.instanceId='other';}},
 {name:'manifest',change:live=>{live.grants[0]!.pkg.manifest.sha256='f'.repeat(64);}},
 {name:'revision',change:live=>{live.grants[0]!.selection.revision++;}},
 {name:'modelPin',change:live=>{live.grants[0]!.selection.modelPin='b'.repeat(64);}},
 {name:'model',change:live=>{live.grants[0]!.selection.profile.model='neurocenter/model-other/sha256/'+'a'.repeat(64);}},
 {name:'dimension',change:live=>{live.grants[0]!.selection.profile.dimension=7;}},
 {name:'relayPort',change:live=>{live.relay.port++;}},
 {name:'callerKey',change:live=>{live.grants[0]!.key='c'.repeat(64);}},
])('Смена $name во время inference по-прежнему запрещает выдачу старого ответа',async({change})=>{
 const waiting=gate(),sent=broker(),first=profile(),relay=await createHostedRelay(first);
 try{const request=nativeFetch(`http://127.0.0.1:${first.relay.port}/v1/embeddings`,{method:'POST',headers:{authorization:'Bearer '+first.grants[0]!.key},body:JSON.stringify({model:first.grants[0]!.selection.profile.model,input:'request-A'})});
  await waiting.entered;change(relay.profile);waiting.release();expect((await request).status).toBe(409);expect(sent[0]?.expectedRevision).toBe(1);
 }finally{waiting.release();await relay.close();}
});
it('infer сохраняет собственный snapshot до первой асинхронной проверки',async()=>{
 const waiting=gate(),sent=broker(),first=profile(),expected=first.grants[0]!.selection.profile.model;
 const result=inferHosted(requestProfile(first,first.grants[0]!), 'request-A',AbortSignal.timeout(5000));await waiting.entered;first.grants[0]!.selection=selection(2,'b'.repeat(64));waiting.release();
 expect((await result as {model:string}).model).toBe(expected);expect(sent[0]?.model).toBe(expected);expect(sent[0]?.expectedRevision).toBe(1);
});
it('Добавление соседнего явно подключённого grant не отменяет запрос исходного пакета',async()=>{
 const waiting=gate(),sent=broker(),first=profile(),relay=await createHostedRelay(first);
 try{const request=nativeFetch(`http://127.0.0.1:${first.relay.port}/v1/embeddings`,{method:'POST',headers:{authorization:'Bearer '+first.grants[0]!.key},body:JSON.stringify({model:first.grants[0]!.selection.profile.model,input:'request-A'})});
  await waiting.entered;relay.profile.grants.push({...structuredClone(first.grants[0]!),key:'f'.repeat(64),selection:selection(2,'b'.repeat(64))});waiting.release();expect((await request).status).toBe(200);expect(sent[0]?.expectedRevision).toBe(1);
 }finally{waiting.release();await relay.close();}
});
it('Удаление caller grant на await не разрешает ответ через сохранившийся соседний grant',async()=>{
 const waiting=gate(),sent=broker(),first=profile(),relay=await createHostedRelay(first);
 try{const request=nativeFetch(`http://127.0.0.1:${first.relay.port}/v1/embeddings`,{method:'POST',headers:{authorization:'Bearer '+first.grants[0]!.key},body:JSON.stringify({model:first.grants[0]!.selection.profile.model,input:'request-A'})});
  await waiting.entered;relay.profile.grants=[{...structuredClone(first.grants[0]!),key:'f'.repeat(64)}];waiting.release();expect((await request).status).toBe(409);expect(sent[0]?.expectedRevision).toBe(1);
 }finally{waiting.release();await relay.close();}
});
it('Удаление установки во время inference проверяется до выдачи векторов',async()=>{
 const sent=broker(),first=profile();let calls=0;state.assert.mockImplementation(async()=>{if(++calls>1)throw new Error('Установка удалена');});const relay=await createHostedRelay(first);
 try{const response=await nativeFetch(`http://127.0.0.1:${first.relay.port}/v1/embeddings`,{method:'POST',headers:{authorization:'Bearer '+first.grants[0]!.key},body:JSON.stringify({model:first.grants[0]!.selection.profile.model,input:'request-A'})});expect(response.status).toBe(503);expect(sent).toHaveLength(1);expect(calls).toBe(2);
 }finally{await relay.close();}
});
