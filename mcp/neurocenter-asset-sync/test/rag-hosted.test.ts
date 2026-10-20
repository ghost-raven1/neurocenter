import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {readPrivateConfiguration,writePrivateConfiguration} from '../src/features/local-configuration/private-store.js';
import {normalizeHostedProfile,profileKey,type HostedProfile} from '../src/features/rag-hosted/profile.js';
import {localEmbeddingIdentity,assertVerifiedIndex} from '../src/features/rag-index/readiness.js';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {workspaceFixture} from './bridge-fixture.js';
import {setPackage,rehashPackage} from './install-set-fixture.js';
import {install} from '../src/bridge/installer.js';
import {assetKey} from '../src/bridge/installation-receipt.js';
import {projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import {hub,writeState} from '../src/bridge/state.js';
import {connectHostedRag as connectHostedRagRuntime,readHostedRagEmbedding,startHostedRagConnections,stopHostedRagConnections} from '../src/features/rag-hosted/index.js';
const pin='a'.repeat(64), model='neurocenter/fixture/sha256/'+pin;
const selection={revision:1,modelPin:pin,profile:{provider:'openai' as const,model,dimension:3},model:{id:'fixture'}};
const nativeFetch=globalThis.fetch;
let temporary:string,root:string,bindingId:string,instanceId:string,pkg:ReturnType<typeof setPackage>;
let requests:Array<{route:string;body:Record<string,unknown>;authorization:string|null}>,fail=false,invalid=false,currentRevision=1;
beforeEach(async()=>{
 ({temporary,root}=await workspaceFixture()); bindingId=await projectBindingId('test-project');instanceId=await projectInstanceId('test-project');
 pkg=setPackage('hosted-rag');pkg.schemaVersion=5;pkg.config!.extra={hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1}};rehashPackage(pkg);await install('test-project',pkg,async()=>{},async()=>{});
 await writeState('credentials',{deviceId:'fixture-device',token:'initial-device-token',email:'fixture@example.test'});requests=[];fail=false;invalid=false;currentRevision=1;
 vi.stubGlobal('fetch',vi.fn(async(input:Parameters<typeof fetch>[0],options?:RequestInit)=>{
  if(!String(input).startsWith(hub()+'/api/device-channel/'))return nativeFetch(input,options);
  const route=String(input).split('/api/device-channel/')[1]!;const body=JSON.parse(String(options?.body));requests.push({route,body,authorization:new Headers(options?.headers).get('authorization')});
  if(fail)return Response.json({message:'private upstream detail'},{status:503});
  if(body.expectedRevision!==undefined&&body.expectedRevision!==currentRevision)return Response.json({message:'selection changed'},{status:409});
  if(route==='embedding/context')return Response.json({projectId:'test-project',...selection,revision:currentRevision,expectedDimension:3});
  return Response.json({model,data:(Array.isArray(body.input)?body.input:[body.input]).map((_:unknown,index:number)=>({index,embedding:invalid?[0,0,0]:[1,2,3]}))});
 }));
});
afterEach(async()=>{await stopHostedRagConnections();vi.unstubAllGlobals();vi.unstubAllEnvs();await fs.rm(temporary,{recursive:true,force:true});});
// The connector owns authorization/relay rollback; native index/journal commit has its own real-LanceDB suite.
const connectHostedRag=(...args:[string,string,string,Parameters<typeof connectHostedRagRuntime>[3],Parameters<typeof connectHostedRagRuntime>[4],()=>Promise<void>])=>connectHostedRagRuntime(...args,async context=>{
 await writePrivateConfiguration(context.key,context.after,context.before===null?undefined:context.before);return {complete:true,rowCount:0,snapshotHash:'f'.repeat(64)};
});
async function connect(){return connectHostedRag('test-project',bindingId,instanceId,pkg,selection,async()=>{});}
async function privateProfile(){return normalizeHostedProfile(await readPrivateConfiguration(profileKey(hub(),root,instanceId)));}
async function relayRequest(input:unknown,headers:Record<string,string>={}){const value=await privateProfile();return requestGrant(value,value.grants[0]!.key,input,headers);}
async function requestGrant(value:HostedProfile,key:string,input:unknown='x',headers:Record<string,string>={}){return nativeFetch(`http://127.0.0.1:${value.relay.port}/v1/embeddings`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key,...headers},body:JSON.stringify({model,input})});}
async function addPlugin(connectNow=true){const second=setPackage('hosted-plugin','plugin');second.schemaVersion=5;second.config!.extra={hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1}};rehashPackage(second);await install('test-project',second,async()=>{},async()=>{});if(connectNow)await connectHostedRag('test-project',bindingId,instanceId,second,{...selection,revision:currentRevision},async()=>{});return second;}
async function historicalLegacy(){
 await connect();const first=await privateProfile(),grant=first.grants[0]!;await stopHostedRagConnections();pkg.config!.extra={hostedEmbedding:{schemaVersion:1}};rehashPackage(pkg);await install('test-project',pkg,async()=>{},async()=>{});
 const legacy={schemaVersion:1,server:first.server,root,projectId:first.projectId,bindingId,instanceId,pkg,selection:grant.selection,relay:{port:first.relay.port,key:grant.key}};
 await writePrivateConfiguration(profileKey(hub(),root,instanceId),legacy,await readPrivateConfiguration(profileKey(hub(),root,instanceId)));await startHostedRagConnections();return legacy;
}
async function embedding(){const value=await readHostedRagEmbedding(root);expect(value).toBeDefined();return value!;}
describe('Приватное подключение серверной модели к RAG',()=>{
 it('До подтверждённого local commit приватный grant не меняется; отказ stage восстанавливает прежний relay',async()=>{
  await connect();const before=await privateProfile(),key=profileKey(hub(),root,instanceId);let candidateKey='';currentRevision=2;
  await expect(connectHostedRagRuntime('test-project',bindingId,instanceId,pkg,{...selection,revision:2},async()=>{},async publication=>{
   expect(await readPrivateConfiguration(key)).toEqual(before);candidateKey=publication.embedding.apiKey;expect(candidateKey).not.toBe(before.grants[0]!.key);
   const old=await requestGrant(before,before.grants[0]!.key);expect(old.status).not.toBe(401);expect(requests.at(-1)!.body.expectedRevision).toBe(1);
   throw new Error('isolated stage failed');
  })).rejects.toThrow('isolated stage failed');
  expect(await privateProfile()).toEqual(before);currentRevision=1;expect((await requestGrant(before,before.grants[0]!.key)).status).toBe(200);expect((await requestGrant(before,candidateKey)).status).toBe(401);
 });
 it('relay запрещает браузер, чужую модель и больше 64 входов до обращения к серверу',async()=>{
  await connect();const before=requests.length;
  expect((await relayRequest(['x'],{origin:'https://example.test'})).status).toBe(403);
  expect((await relayRequest(Array(65).fill('x'))).status).toBe(400);
  const value=await privateProfile();expect((await nativeFetch(`http://127.0.0.1:${value.relay.port}/v1/embeddings`,{method:'POST',headers:{authorization:'Bearer '+value.grants[0]!.key},body:JSON.stringify({model:'other',input:'x'})})).status).toBe(400);
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
  expect(await connect()).toEqual({status:'connected',revision:1,modelPin:pin,profile:selection.profile,requiresRestart:true,reindex:{complete:true,rowCount:0,snapshotHash:'f'.repeat(64)}});
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

it('Явное подключение MCP и плагина сохраняет оба exact-grant и отдельные ключи на одном порту',async()=>{
 await connect();const second=setPackage('hosted-plugin','plugin');second.schemaVersion=5;second.config!.extra={hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1}};rehashPackage(second);await install('test-project',second,async()=>{},async()=>{});
 await connectHostedRag('test-project',bindingId,instanceId,second,selection,async()=>{});
 const saved=await readPrivateConfiguration<{schemaVersion:number;grants:Array<{pkg:{manifest:{sha256:string}};key:string}>;relay:{port:number}}>(profileKey(hub(),root,instanceId));
 expect(saved?.schemaVersion).toBe(2);expect(saved?.grants.map(grant=>grant.pkg.manifest.sha256)).toEqual([pkg.manifest.sha256,second.manifest.sha256]);expect(new Set(saved?.grants.map(grant=>grant.key)).size).toBe(2);
});

it('Удалённый последний grant не заимствует соседний ключ и не блокирует готовность и restart',async()=>{
 await connect();const second=await addPlugin(),saved=await privateProfile();const firstKey=saved.grants[0]!.key,secondKey=saved.grants[1]!.key;
 await fs.rm(path.join(root,'.opencode/neurocenter/receipts',assetKey(second)+'.json'));
 expect((await requestGrant(saved,secondKey)).status).toBe(503);expect((await requestGrant(saved,firstKey)).status).toBe(200);expect((await embedding()).model).toBe(model);
 await stopHostedRagConnections();await startHostedRagConnections();expect((await requestGrant(saved,firstKey)).status).toBe(200);expect((await requestGrant(saved,secondKey)).status).toBe(503);
});
it('Новая revision другого пакета не переносит согласие старого grant',async()=>{
 await connect();const first=await privateProfile();currentRevision=2;await addPlugin();const saved=await privateProfile();
 expect(saved.grants[0]!.selection.revision).toBe(1);expect(saved.grants[1]!.selection.revision).toBe(2);expect((await requestGrant(saved,first.grants[0]!.key)).status).toBe(409);expect((await requestGrant(saved,saved.grants[1]!.key)).status).toBe(200);
 await connectHostedRag('test-project',bindingId,instanceId,pkg,{...selection,revision:2},async()=>{});const renewed=await privateProfile();expect((await requestGrant(renewed,first.grants[0]!.key)).status).toBe(401);expect(renewed.grants.find(grant=>grant.pkg.plugin.id===pkg.plugin.id)!.selection.revision).toBe(2);
});
it('Обновление exact-пакета отзывает прежний ключ, сохраняя соседний grant',async()=>{
 await connect();await addPlugin();const before=await privateProfile(),oldKey=before.grants[0]!.key;pkg.plugin.version++;rehashPackage(pkg);await install('test-project',pkg,async()=>{},async()=>{});
 expect((await requestGrant(before,oldKey)).status).toBe(503);expect((await requestGrant(before,before.grants[1]!.key)).status).toBe(200);await connect();const saved=await privateProfile();expect((await requestGrant(saved,oldKey)).status).toBe(401);expect((await requestGrant(saved,saved.grants.find(grant=>grant.pkg.plugin.id===pkg.plugin.id)!.key)).status).toBe(200);
});
it('Явная миграция legacy с marker2 сохраняет port, key и прежний exact-grant',async()=>{
 await connect();const first=await privateProfile(),grant=first.grants[0]!;await stopHostedRagConnections();const legacy={schemaVersion:1,server:first.server,root,projectId:first.projectId,bindingId,instanceId,pkg:grant.pkg,selection:grant.selection,relay:{port:first.relay.port,key:grant.key}};
 await writePrivateConfiguration(profileKey(hub(),root,instanceId),legacy,await readPrivateConfiguration(profileKey(hub(),root,instanceId)));await startHostedRagConnections();expect(await readPrivateConfiguration(profileKey(hub(),root,instanceId))).toEqual(legacy);await addPlugin();const saved=await privateProfile();expect(saved.relay.port).toBe(first.relay.port);expect(saved.grants[0]).toEqual(grant);expect((await requestGrant(saved,grant.key)).status).toBe(200);
});
it('Старый pack7 доступен историческому grant, но новое подключение требует управляемую переиндексацию',async()=>{
 const raw=await historicalLegacy();expect(raw.schemaVersion).toBe(1);await expect(connect()).rejects.toThrow('Обновите этот OpenCodeRAG');
 await expect(addPlugin()).rejects.toThrow('обновите MCP и плагин');expect(await readPrivateConfiguration(profileKey(hub(),root,instanceId))).toEqual(raw);expect((await relayRequest('x')).status).toBe(200);
 pkg.config!.extra={hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1}};rehashPackage(pkg);await install('test-project',pkg,async()=>{},async()=>{});await connect();const v2=await privateProfile();const legacy=setPackage('legacy-other');legacy.schemaVersion=5;legacy.config!.extra={hostedEmbedding:{schemaVersion:1}};rehashPackage(legacy);await install('test-project',legacy,async()=>{},async()=>{});await expect(connectHostedRag('test-project',bindingId,instanceId,legacy,selection,async()=>{})).rejects.toThrow('Обновите этот OpenCodeRAG');expect(await privateProfile()).toEqual(v2);
});
it.each(['empty','duplicate-key','duplicate-pkg','unknown-schema','unknown-field','bad-selection'] as const)('Повреждённый schema2 не превращается в defaults: %s',async fault=>{
 await connect();const before=await privateProfile(),bad=structuredClone(before);if(fault==='empty')bad.grants=[];if(fault==='duplicate-key')bad.grants.push({...bad.grants[0]!,pkg:rehashPackage({...structuredClone(pkg),plugin:{...pkg.plugin,id:'other'}})});if(fault==='duplicate-pkg')bad.grants.push({...bad.grants[0]!,key:'f'.repeat(64)});if(fault==='unknown-schema')(bad as {schemaVersion:number}).schemaVersion=3;if(fault==='unknown-field')Object.assign(bad,{untrusted:true});if(fault==='bad-selection')bad.grants[0]!.selection.profile.dimension=0;
 await writePrivateConfiguration(profileKey(hub(),root,instanceId),bad,await readPrivateConfiguration(profileKey(hub(),root,instanceId)));await expect(readHostedRagEmbedding(root)).rejects.toThrow('повреждено');await expect(connect()).rejects.toThrow('повреждено');expect(await readPrivateConfiguration(profileKey(hub(),root,instanceId))).toEqual(bad);
});
it('Устаревший удалённый legacy grant не переносится и не получает согласие за соседний пакет',async()=>{
 await historicalLegacy();const second=await addPlugin(false);await fs.rm(path.join(root,'.opencode/neurocenter/receipts',assetKey(pkg)+'.json'));await connectHostedRag('test-project',bindingId,instanceId,second,selection,async()=>{});const saved=await privateProfile();expect(saved.grants).toHaveLength(1);expect(saved.grants[0]!.pkg.manifest.sha256).toBe(second.manifest.sha256);
});
it.each([null,false,[]])('Присутствующий повреждённый private JSON не считается отсутствующим профилем: %j',async bad=>{
 await connect();await writePrivateConfiguration(profileKey(hub(),root,instanceId),bad,await readPrivateConfiguration(profileKey(hub(),root,instanceId)));await expect(readHostedRagEmbedding(root)).rejects.toThrow('повреждено');await expect(connect()).rejects.toThrow('повреждено');
});
it.each(['equal-revision-diff','different-profile','removed-neighbor'] as const)('Готовность общего индекса учитывает только совместимые действующие grants: %s',async mode=>{
 await connect();const other=await addPlugin(),before=await privateProfile(),saved=structuredClone(before);saved.grants[1]!.selection.revision=2;
 if(mode!=='equal-revision-diff'){const pin='b'.repeat(64);saved.grants[1]!.selection={...selection,revision:2,modelPin:pin,profile:{provider:'openai',model:'neurocenter/other/sha256/'+pin,dimension:3}};}
 await writePrivateConfiguration(profileKey(hub(),root,instanceId),saved,await readPrivateConfiguration(profileKey(hub(),root,instanceId)));if(mode==='removed-neighbor')await fs.rm(path.join(root,'.opencode/neurocenter/receipts',assetKey(other)+'.json'));
 const located={root,config:null,configPath:null,storePath:null};if(mode==='different-profile')await expect(localEmbeddingIdentity(located,3)).rejects.toThrow('одну модель');else expect((await localEmbeddingIdentity(located,3)).profile).toEqual(selection.profile);
});
