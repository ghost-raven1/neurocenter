import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {withManagedIndexProfile,requireManagedIndexProfile} from '../adapters/rag-index-profile.mjs';
import {applyHostedRuntimeCompatibility} from '../opencode-rag.mjs';
import {embeddingSignature} from '../../../../services/shared/rag-index-contract.cjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
async function fixture(){
 const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rag-hosted-adapter-')));const server='https://fixture.example.test';const artifact=path.join(temp,'private',sha(server).slice(0,20),'runtime-artifacts','a'.repeat(64));const root=path.join(temp,'project');await fs.mkdir(artifact,{recursive:true});await fs.mkdir(path.join(root,'.opencode/neurocenter/receipts'),{recursive:true});
 await fs.writeFile(path.join(artifact,'rag-hosted.mjs'),(await fs.readFile(new URL('../adapters/rag-hosted.mjs',import.meta.url),'utf8')).replace('../../../../services/shared/rag-index-contract.cjs','./rag-index-contract.cjs'));await fs.copyFile(new URL('../../../../services/shared/rag-index-contract.cjs',import.meta.url),path.join(artifact,'rag-index-contract.cjs'));
 const instanceId='fixture-instance',projectId='fixture-project';const modelPin='b'.repeat(64);const profile={provider:'openai',model:'neurocenter/model-fixture/sha256/'+modelPin,dimension:3};
 const pkg={plugin:{id:'rag-fixture',kind:'plugin',version:1},manifest:{sha256:'c'.repeat(64)},config:{extra:{hostedEmbedding:{schemaVersion:1},runtimeArtifacts:[{sha256:'a'.repeat(64)}]}}};
 await fs.writeFile(path.join(root,'.opencode/neurocenter.json'),JSON.stringify({version:2,server,instanceId,projectId}));await fs.writeFile(path.join(root,'.opencode/neurocenter/receipts',sha('plugin:rag-fixture').slice(0,24)+'.json'),JSON.stringify({version:1,manifest:pkg.manifest.sha256}));
 const privateDir=path.join(temp,'private',sha(server).slice(0,20),'local-configuration');await fs.mkdir(privateDir,{mode:0o700});const file=path.join(privateDir,sha(JSON.stringify([server,root,instanceId]))+'.json');
 const record={schemaVersion:1,server,root,projectId,instanceId,bindingId:'binding-fixture',pkg,selection:{revision:1,modelPin,profile},relay:{port:34567,key:'d'.repeat(64)}};
 await fs.writeFile(file,JSON.stringify(record),{mode:0o600});await fs.writeFile(path.join(path.dirname(privateDir),'rag-hosted-connections.json'),JSON.stringify([path.basename(file,'.json')]));
 const adapter=await import(pathToFileURL(path.join(artifact,'rag-hosted.mjs')).href);return {temp,root,file,record,adapter};
}
test('Приватный hosted-профиль применяется без project secret и без автоматической смены индекса',async()=>{
 const f=await fixture();try{const config={embedding:{provider:'ollama',model:'old'},indexing:{embedBatchSize:100,embedConcurrency:3},vectorStore:{path:'.rag'},openCode:{autoIndex:{enabled:true}}};
 const result=f.adapter.applyHostedRagConfiguration(config,f.root);assert.equal(result.embedding.model,f.record.selection.profile.model);assert.equal(result.embedding.apiKey,f.record.relay.key);assert.equal(result.embedding.timeoutMs,120000);assert.equal(result.indexing.embedBatchSize,8);assert.equal(result.indexing.embedConcurrency,1);assert.equal(result.openCode.autoIndex.enabled,false);assert.equal(config.embedding.model,'old');
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
test('Совместимый готовый hosted-индекс не даёт согласия на автоматическую индексацию при запуске',async()=>{
 const f=await fixture();try{const config={embedding:{provider:'ollama',model:'old'},vectorStore:{path:'.rag'},openCode:{autoIndex:{enabled:true}}};const store=path.join(f.root,'.rag');await fs.mkdir(store);const before=JSON.stringify({schemaVersion:1,state:'ready',profile:f.record.selection.profile,embeddingSignature:embeddingSignature(f.record.selection.profile,'http://127.0.0.1:34567/v1')});await fs.writeFile(path.join(store,'neurocenter-index-profile.json'),before);
 const result=f.adapter.applyHostedRagConfiguration(config,f.root);assert.equal(result.openCode.autoIndex.enabled,false);assert.equal(config.openCode.autoIndex.enabled,true);assert.equal(await fs.readFile(path.join(store,'neurocenter-index-profile.json'),'utf8'),before);
 const clone=structuredClone(result);clone.openCode.autoIndex.enabled=true;assert.equal(f.adapter.preserveHostedRagConfiguration(result,clone).openCode.autoIndex.enabled,false);
 const ordinary={embedding:{model:'ordinary'},openCode:{autoIndex:{enabled:true}}};assert.equal(f.adapter.preserveHostedRagConfiguration(ordinary,structuredClone(ordinary)).openCode.autoIndex.enabled,true);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
test('Небезопасный приватный файл и обновлённый receipt не откатываются на defaults',async()=>{
 const f=await fixture();try{await fs.chmod(f.file,0o644);assert.throws(()=>f.adapter.applyHostedRagConfiguration({},f.root),/Приватное/);await fs.chmod(f.file,0o600);f.record.pkg.manifest.sha256='e'.repeat(64);await fs.writeFile(f.file,JSON.stringify(f.record));assert.throws(()=>f.adapter.applyHostedRagConfiguration({},f.root),/OpenCodeRAG/);}finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('Явный native reindex игнорирует старый override только для проверенного hosted-профиля',async()=>{
 const f=await fixture();try{const store=path.join(f.root,'.rag');await fs.mkdir(store);const old=JSON.stringify({embedding:{provider:'ollama',model:'old',baseUrl:'http://localhost:11434/api'}});await fs.writeFile(path.join(store,'runtime-overrides.json'),old);
 const config=f.adapter.applyHostedRagConfiguration({embedding:{},vectorStore:{path:'.rag'},openCode:{autoIndex:{enabled:true}}},f.root);let ran=0;const options={config,storePath:store,dimension:3,embedder:{model:f.record.selection.profile.model},store:{count:async()=>2}};
 await withManagedIndexProfile(options,async next=>{ran++;assert.equal(next.force,true);await fs.writeFile(path.join(store,'manifest.json'),JSON.stringify({lastIndexedAt:Date.now()}));return {finalCount:2};});assert.equal(ran,1);await requireManagedIndexProfile(options.store,store,config,3,options.embedder);assert.equal(await fs.readFile(path.join(store,'runtime-overrides.json'),'utf8'),old);
 const clone=structuredClone(config);assert.equal(f.adapter.preserveHostedRagConfiguration(config,clone).embedding.model,f.record.selection.profile.model);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('Upstream runtime-overrides переносит hosted identity после clone и неизвестный исходник не правит',async()=>{
 const f=await fixture();try{const directory=path.dirname(path.dirname(f.file));const file=path.join(directory,'upstream/dist/core/runtime-overrides.js');await fs.mkdir(path.dirname(file),{recursive:true});await fs.copyFile(path.join(directory,'runtime-artifacts','a'.repeat(64),'rag-hosted.mjs'),path.join(directory,'rag-hosted.mjs'));await fs.copyFile(new URL('../../../../services/shared/rag-index-contract.cjs',import.meta.url),path.join(directory,'rag-index-contract.cjs'));
 await fs.writeFile(file,'export function applyRuntimeOverrides(cfg, overrides) { const merged = structuredClone(cfg); merged.embedding.model = overrides.model;\n    return merged;\n}');await applyHostedRuntimeCompatibility(directory);const {applyRuntimeOverrides}=await import(pathToFileURL(file).href);const config=f.adapter.applyHostedRagConfiguration({embedding:{},vectorStore:{path:'.rag'},openCode:{autoIndex:{enabled:true}}},f.root);assert.equal(applyRuntimeOverrides(config,{model:'old'}).embedding.model,f.record.selection.profile.model);assert.equal(applyRuntimeOverrides({embedding:{model:'ordinary'}},{model:'changed'}).embedding.model,'changed');
 await assert.rejects(applyHostedRuntimeCompatibility(directory),/runtime overrides/);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

for(const fault of ['instance','server','missing-private'])test('Смена marker или потеря private-профиля не запускает fallback автоиндексацию: '+fault,async()=>{
 const f=await fixture();try{const store=path.join(f.root,'.rag');await fs.mkdir(store);await fs.writeFile(path.join(store,'neurocenter-index-profile.json'),JSON.stringify({schemaVersion:1,state:'ready',profile:f.record.selection.profile}));const marker=path.join(f.root,'.opencode/neurocenter.json'),before=JSON.parse(await fs.readFile(marker,'utf8'));
 if(fault==='instance')await fs.writeFile(marker,JSON.stringify({...before,instanceId:'replacement-instance'}));if(fault==='server')await fs.writeFile(marker,JSON.stringify({...before,server:'https://other.example.test'}));if(fault==='missing-private')await fs.rm(f.file);
 assert.throws(()=>f.adapter.applyHostedRagConfiguration({embedding:{model:'old'},vectorStore:{path:'.rag'},openCode:{autoIndex:{enabled:true}}},f.root),/Приватное/);assert.equal(JSON.parse(await fs.readFile(path.join(store,'neurocenter-index-profile.json'),'utf8')).profile.model,f.record.selection.profile.model);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
test('Потеря private-профиля до первой индексации определяется по own registry',async()=>{
 const f=await fixture();try{await fs.writeFile(path.join(path.dirname(path.dirname(f.file)),'rag-hosted-connections.json'),JSON.stringify([path.basename(f.file,'.json')]));const marker=path.join(f.root,'.opencode/neurocenter.json'),before=JSON.parse(await fs.readFile(marker,'utf8'));await fs.writeFile(marker,JSON.stringify({...before,instanceId:'replacement-instance'}));assert.throws(()=>f.adapter.applyHostedRagConfiguration({embedding:{},openCode:{autoIndex:{enabled:true}}},f.root),/Приватное/);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('Удаление marker до первой индексации не превращает настроенный hosted-проект в новый',async()=>{
 const f=await fixture();try{await fs.rm(path.join(f.root,'.opencode/neurocenter.json'));assert.throws(()=>f.adapter.applyHostedRagConfiguration({embedding:{},openCode:{autoIndex:{enabled:true}}},f.root),/Приватное/);}finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('Обычный проект с повреждённым provenance сохраняет возможность явного native rebuild',async()=>{
 const f=await fixture();try{await fs.rm(f.file);await fs.rm(path.join(path.dirname(path.dirname(f.file)),'rag-hosted-connections.json'));const store=path.join(f.root,'.rag');await fs.mkdir(store);await fs.writeFile(path.join(store,'neurocenter-index-profile.json'),'{bad');const config={embedding:{provider:'ollama',model:'ordinary'},vectorStore:{path:'.rag'},openCode:{autoIndex:{enabled:false}}};assert.deepEqual(f.adapter.applyHostedRagConfiguration(config,f.root),config);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
