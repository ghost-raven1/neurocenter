import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {readPrivateConfiguration,writePrivateConfiguration} from '../src/features/local-configuration/private-store.js';
import {profileKey,type HostedProfile} from '../src/features/rag-hosted/profile.js';
import {localEmbeddingIdentity,assertVerifiedIndex} from '../src/features/rag-index/readiness.js';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {workspaceFixture} from './bridge-fixture.js';
import {setPackage,rehashPackage} from './install-set-fixture.js';
import {install} from '../src/bridge/installer.js';
import {projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import {hub,writeState} from '../src/bridge/state.js';
import {connectHostedRag,readHostedRagEmbedding,startHostedRagConnections,stopHostedRagConnections} from '../src/features/rag-hosted/index.js';
const pin='a'.repeat(64), model='neurocenter/fixture/sha256/'+pin;
const selection={revision:1,modelPin:pin,profile:{provider:'openai' as const,model,dimension:3},model:{id:'fixture'}};
const nativeFetch=globalThis.fetch;
let temporary:string,root:string,bindingId:string,instanceId:string,pkg:ReturnType<typeof setPackage>;
let requests:Array<{route:string;body:Record<string,unknown>;authorization:string|null}>,fail=false,invalid=false;
beforeEach(async()=>{
 ({temporary,root}=await workspaceFixture()); bindingId=await projectBindingId('test-project');instanceId=await projectInstanceId('test-project');
 pkg=setPackage('hosted-rag');pkg.schemaVersion=5;pkg.config!.extra={hostedEmbedding:{schemaVersion:1}};rehashPackage(pkg);await install('test-project',pkg,async()=>{},async()=>{});
 await writeState('credentials',{deviceId:'fixture-device',token:'initial-device-token',email:'fixture@example.test'});requests=[];fail=false;invalid=false;
 vi.stubGlobal('fetch',vi.fn(async(input:Parameters<typeof fetch>[0],options?:RequestInit)=>{
  if(!String(input).startsWith(hub()+'/api/device-channel/'))return nativeFetch(input,options);
  const route=String(input).split('/api/device-channel/')[1]!;const body=JSON.parse(String(options?.body));requests.push({route,body,authorization:new Headers(options?.headers).get('authorization')});
  if(fail)return Response.json({message:'private upstream detail'},{status:503});
  if(route==='embedding/context')return Response.json({projectId:'test-project',...selection,revision:body.expectedRevision??1,expectedDimension:3});
  return Response.json({model,data:(Array.isArray(body.input)?body.input:[body.input]).map((_:unknown,index:number)=>({index,embedding:invalid?[0,0,0]:[1,2,3]}))});
 }));
});
afterEach(async()=>{await stopHostedRagConnections();vi.unstubAllGlobals();vi.unstubAllEnvs();await fs.rm(temporary,{recursive:true,force:true});});
async function connect(){return connectHostedRag('test-project',bindingId,instanceId,pkg,selection,async()=>{});}
async function privateProfile(){return (await readPrivateConfiguration<HostedProfile>(profileKey(hub(),root,instanceId)))!;}
async function relayRequest(input:unknown,headers:Record<string,string>={}){const value=await privateProfile();return nativeFetch(`http://127.0.0.1:${value.relay.port}/v1/embeddings`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+value.relay.key,...headers},body:JSON.stringify({model,input})});}
async function embedding(){const value=await readHostedRagEmbedding(root);expect(value).toBeDefined();return value!;}
describe('Приватное подключение серверной модели к RAG',()=>{
 it('relay запрещает браузер, чужую модель и больше 64 входов до обращения к серверу',async()=>{
  await connect();const before=requests.length;
  expect((await relayRequest(['x'],{origin:'https://example.test'})).status).toBe(403);
  expect((await relayRequest(Array(65).fill('x'))).status).toBe(400);
  const value=await privateProfile();expect((await nativeFetch(`http://127.0.0.1:${value.relay.port}/v1/embeddings`,{method:'POST',headers:{authorization:'Bearer '+value.relay.key},body:JSON.stringify({model:'other',input:'x'})})).status).toBe(400);
  expect(requests).toHaveLength(before);expect((await relayRequest(['x','y'])).status).toBe(200);
 });
 it('свежий отказ сервера не раскрывает ответ и исчезнувшие файлы закрывают inference',async()=>{
  await connect();fail=true;const response=await relayRequest('x');expect(response.status).toBe(503);expect(await response.text()).not.toContain('private upstream');
  fail=false;await fs.rm(path.join(root,'.opencode/mcp-bundles', (await import('../src/bridge/installation-receipt.js')).assetKey(pkg),'index.mjs'));
  const before=requests.length;expect((await relayRequest('x')).status).toBe(503);expect(requests).toHaveLength(before);
 });
 it('restore при недоступном сервере не ждёт context и восстанавливает прежний порт',async()=>{
  await connect();const previous=await embedding();await stopHostedRagConnections();fail=true;const before=requests.length;await startHostedRagConnections();expect(requests).toHaveLength(before);expect(await embedding()).toEqual(previous);expect((await relayRequest('x')).status).toBe(503);fail=false;expect((await relayRequest('x')).status).toBe(200);
 });
 it('занятый прежний порт не меняет сохранённую identity индекса',async()=>{
  await connect();const previous=await privateProfile();await stopHostedRagConnections();const server=http.createServer();await new Promise<void>(resolve=>server.listen(previous.relay.port,'127.0.0.1',resolve));try{await startHostedRagConnections();await expect(connect()).rejects.toThrow();expect(await privateProfile()).toEqual(previous);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it('два одновременных явных подключения используют один адрес',async()=>{
  await Promise.all([connect(),connect()]);const previous=await embedding();await connect();expect(await embedding()).toEqual(previous);
 });
 it('CAS-конфликт оставляет чужую private-настройку и не публикует новый relay',async()=>{
  let calls=0;await expect(connectHostedRag('test-project',bindingId,instanceId,pkg,selection,async()=>{if(++calls===2)await writePrivateConfiguration(profileKey(hub(),root,instanceId),{other:'newer'},undefined);})).rejects.toThrow('другом окне');expect(await readPrivateConfiguration(profileKey(hub(),root,instanceId))).toEqual({other:'newer'});
 });
 it('готовность берёт hosted identity и не считает прежний индекс новым',async()=>{
  await connect();const store=path.join(root,'.rag');await fs.mkdir(store);await fs.writeFile(path.join(store,'runtime-overrides.json'),JSON.stringify({embedding:{provider:'ollama',model:'old',baseUrl:'http://localhost:11434/api'}}));
  const located={root,config:null,configPath:null,storePath:store};expect((await localEmbeddingIdentity(located,3)).profile).toEqual(selection.profile);
  await fs.writeFile(path.join(store,'neurocenter-index-profile.json'),JSON.stringify({schemaVersion:1,state:'ready',profile:{provider:'ollama',model:'old',dimension:3}}));await expect(assertVerifiedIndex(located,3)).rejects.toThrow();
 });

 it('проверяет два вектора, сохраняет только приватный профиль и не меняет индекс',async()=>{
  const index=path.join(root,'.rag');await fs.mkdir(index);await fs.writeFile(path.join(index,'old-index'),'original');
  expect(await connect()).toEqual({status:'connected',revision:1,modelPin:pin,profile:selection.profile,requiresRestart:true});
  expect(requests.filter(r=>r.route==='embedding')[0]?.body.input).toHaveLength(2);
  const effective=await embedding();expect(effective.model).toBe(model);expect(effective.provider).toBe('openai');
  expect(await fs.readFile(path.join(index,'old-index'),'utf8')).toBe('original');
  expect(await fs.readFile(path.join(root,'.opencode/neurocenter.json'),'utf8')).not.toContain('initial-device-token');
 });
 it('при недоступности или пустых векторах сохраняет прежний профиль',async()=>{
  await connect();const before=await embedding();fail=true;await expect(connect()).rejects.toThrow();expect(await embedding()).toEqual(before);
  fail=false;invalid=true;await expect(connectHostedRag('test-project',bindingId,instanceId,pkg,{...selection,revision:2},async()=>{})).rejects.toThrow();expect(await embedding()).toEqual(before);
 });
 it('повтор и перезапуск сохраняют адрес, а каждый inference читает свежий token',async()=>{
  await connect();const before=await embedding();await connect();expect(await embedding()).toEqual(before);await stopHostedRagConnections();await startHostedRagConnections();expect(await embedding()).toEqual(before);
  await writeState('credentials',{deviceId:'fixture-device',token:'fresh-device-token',email:'fixture@example.test'});
  // Ключ relay доступен только private-store; внешнему localhost клиенту доступ закрыт.
  const denied=await nativeFetch(before.baseUrl+'/embeddings',{method:'POST',body:'{}'});expect(denied.status).toBe(401);
  await connect();expect(requests.at(-1)?.authorization).toBe('Bearer fresh-device-token');
 });
 it('отказ разрешения и изменённая установка не создают соединение',async()=>{
  await expect(connectHostedRag('test-project',bindingId,instanceId,pkg,selection,async()=>{throw new Error('Права отозваны');})).rejects.toThrow('Права отозваны');expect(await readHostedRagEmbedding(root)).toBeUndefined();
  await expect(connectHostedRag('test-project','other-binding',instanceId,pkg,selection,async()=>{})).rejects.toThrow();expect(requests).toHaveLength(0);
 });
});
