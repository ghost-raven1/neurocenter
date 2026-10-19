import {afterEach,expect,it,vi} from 'vitest';
import {createHostedRelay,inferHosted} from '../src/features/rag-hosted/relay.js';
import type {HostedProfile} from '../src/features/rag-hosted/profile.js';
const state=vi.hoisted(()=>({assert:vi.fn()}));
vi.mock('../src/features/rag-hosted/profile.js',()=>({assertHostedInstallation:state.assert}));
vi.mock('../src/bridge/state.js',()=>({hub:()=> 'http://broker.fixture',readState:async()=>({token:'synthetic-device-key'})}));
const nativeFetch=globalThis.fetch;
afterEach(()=>vi.unstubAllGlobals());
function selection(revision:number,pin:string){return {revision,modelPin:pin,profile:{provider:'openai' as const,model:'neurocenter/model-fixture/sha256/'+pin,dimension:3},model:null};}
function profile():HostedProfile{return {schemaVersion:1,server:'http://broker.fixture',root:'/synthetic',projectId:'fixture',bindingId:'binding',instanceId:'instance',pkg:{} as never,selection:selection(1,'a'.repeat(64)),relay:{port:0,key:'d'.repeat(64)}};}
function gate(){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});const pending=new Promise<void>(resolve=>{release=resolve;});state.assert.mockImplementation(async()=>{enter();await pending;});return {entered,release};}
function broker(){const sent:Array<Record<string,unknown>>=[];vi.stubGlobal('fetch',vi.fn(async(_url:unknown,options:RequestInit)=>{const body=JSON.parse(String(options.body));sent.push(body);return Response.json({model:body.model,data:[{index:0,embedding:[1,2,3]}]});}));return sent;}
it('Смена live-профиля на await отклоняет ответ старому клиенту и никогда не подставляет новую модель',async()=>{
 const waiting=gate(),sent=broker(),first=profile(),relay=await createHostedRelay(first);
 try{const request=nativeFetch(`http://127.0.0.1:${first.relay.port}/v1/embeddings`,{method:'POST',headers:{authorization:'Bearer '+first.relay.key},body:JSON.stringify({model:first.selection.profile.model,input:'request-A'})});
  await waiting.entered;relay.profile={...first,selection:selection(2,'b'.repeat(64))};waiting.release();const response=await request;
  expect(response.status).toBe(409);expect(sent[0]?.model).toBe(first.selection.profile.model);expect(sent[0]?.expectedRevision).toBe(1);
 }finally{waiting.release();await relay.close();}
});
it('infer сохраняет собственный snapshot до первой асинхронной проверки',async()=>{
 const waiting=gate(),sent=broker(),first=profile(),expected=first.selection.profile.model;
 const result=inferHosted(first,'request-A',AbortSignal.timeout(5000));await waiting.entered;first.selection=selection(2,'b'.repeat(64));waiting.release();
 expect((await result as {model:string}).model).toBe(expected);expect(sent[0]?.model).toBe(expected);expect(sent[0]?.expectedRevision).toBe(1);
});
