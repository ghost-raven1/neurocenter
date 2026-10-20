import fs from 'node:fs/promises';import path from 'node:path';import {Readable} from 'node:stream';import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';import {workspaceFixture} from './bridge-fixture.js';import {canonicalV4,type Package} from '../src/bridge/package.js';import {hash,hub} from '../src/bridge/state.js';import {projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';import {runtimeArtifactTarget} from '../src/features/runtime-artifacts/model.js';import {ensureRuntimeArtifact} from '../src/features/runtime-artifacts/cache.js';import {install} from '../src/bridge/installer.js';import {readyIndex,row} from './rag-index-fixture.js';import {writeRows} from '../src/lib/lancedb.js';import {openIndexSnapshot} from '../src/features/rag-index/snapshot.js';import {reindexHostedRag} from '../src/features/rag-hosted/reindex.js';import {profileKey} from '../src/features/rag-hosted/profile.js';import {readPrivateConfiguration,writePrivateConfiguration} from '../src/features/local-configuration/private-store.js';import {ProbeScope} from '../src/features/runtime-probe/process.js';import {embeddingSignature} from '../src/features/rag-index/contract.js';

describe('Selected-installation reindex: native LanceDB validation + real journal commit',()=>{
 let fixture:Awaited<ReturnType<typeof workspaceFixture>>,pkg:Package,input:Parameters<typeof reindexHostedRag>[0],publication:Parameters<typeof reindexHostedRag>[1],store:string,profile:{provider:'openai';model:string;dimension:number},prior:unknown;
 let mode='ok';const progress=vi.fn(async()=>{});
 beforeEach(async()=>{
  mode='ok';fixture=await workspaceFixture();store=path.join(fixture.root,'.opencode/rag_db');await readyIndex(fixture.root);await writeRows(store,[row('old')],false,3);
  const {archive,descriptor}=artifactFixture([{path:'opencode-rag.mjs',content:'export default {};'}],runtimeArtifactTarget());
  pkg={schemaVersion:5,plugin:{id:'test-rag-reindex',name:'rag',kind:'mcp',version:9},config:{command:'node',entrypoint:'opencode-rag.mjs',args:['mcp'],extra:{runtimeArtifacts:[descriptor],localUi:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']},hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1}}},files:[],manifest:{sha256:'',filesCount:0}};
  pkg.manifest.sha256=hash(JSON.stringify(canonicalV4({schemaVersion:pkg.schemaVersion,plugin:pkg.plugin,config:pkg.config,files:[]})));await ensureRuntimeArtifact(pkg,{download:async()=>Readable.from([archive])});await install('test-project',pkg,async()=>{},async()=>{});
  input={projectId:'test-project',bindingId:await projectBindingId('test-project'),instanceId:await projectInstanceId('test-project'),pkg};profile={provider:'openai',model:'neurocenter/model-fixture/sha256/'+'b'.repeat(64),dimension:5};
  prior={schemaVersion:2,server:hub(),root:fixture.root,projectId:input.projectId,bindingId:input.bindingId,instanceId:input.instanceId,relay:{port:49152},grants:[{pkg,selection:{revision:1,modelPin:'a'.repeat(64),profile:{...profile,model:'neurocenter/model-fixture/sha256/'+'a'.repeat(64),dimension:3},model:{}},key:'1'.repeat(64)}]};
  const key=profileKey(hub(),fixture.root,input.instanceId);await writePrivateConfiguration(key,prior,undefined);publication={key,before:prior,after:{...prior as object,grants:[{pkg,selection:{revision:2,modelPin:'b'.repeat(64),profile,model:{}},key:'2'.repeat(64)}]},embedding:{profile,baseUrl:'http://127.0.0.1:49152/v1',apiKey:'2'.repeat(64)}};
  vi.spyOn(ProbeScope.prototype,'command').mockImplementation(async(_command,args)=>{
   const stage=args.at(-1)!;
   if(mode==='process')return {code:1,stdout:''};
   const dimension=mode==='dimension'?3:5;
   if(mode!=='zero')await writeRows(stage,[{...row('new'),embedding:Array.from({length:dimension},(_,i)=>i+1)}],false,dimension);
   await fs.writeFile(path.join(stage,'manifest.json'),JSON.stringify({schemaVersion:3,lastIndexedAt:123}));
   const recordedProfile=mode==='profile-model'?{...profile,model:profile.model.replace('model-fixture','model-other')}:mode==='profile-extra'?{...profile,unexpected:true}:profile;
   await fs.writeFile(path.join(stage,'neurocenter-index-profile.json'),JSON.stringify({schemaVersion:1,state:mode==='proof'?'failed':'ready',profile:recordedProfile,embeddingSignature:embeddingSignature(profile,publication.embedding.baseUrl),indexedAt:123}));
   if(mode==='source')await writeRows(store,[row('foreign-edit')],false,3);
   if(mode==='private')await writePrivateConfiguration(key,{...prior as object,relay:{port:49153}},prior);
   return {code:0,stdout:JSON.stringify({complete:true,rowCount:mode==='zero'?0:1,dimension:5})};
  });
 });
 afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});});
 const rows=async()=>{const snap=await openIndexSnapshot(store);try{return {count:snap.rowCount,dimension:snap.dimension,ids:(await snap.selected(['old']).catch(()=>[])).map(row=>row.id)};}finally{snap.close();}};
 it('3→5 switches verified native rows and exact private grant together',async()=>{
  expect(await reindexHostedRag(input,publication,async()=>{},progress)).toMatchObject({complete:true,rowCount:1});expect(await rows()).toMatchObject({count:1,dimension:5,ids:[]});expect(await readPrivateConfiguration(publication.key)).toEqual(publication.after);
 });
 it('JSONB model/provider/dimension order accepts the same canonical native profile and commits its private grant',async()=>{
  const reordered={model:profile.model,provider:profile.provider,dimension:profile.dimension};publication.embedding.profile=reordered;
  (publication.after as {grants:Array<{selection:{profile:typeof profile}}>}).grants[0].selection.profile=reordered;
  expect(Object.keys(reordered)).toEqual(['model','provider','dimension']);
  expect(await reindexHostedRag(input,publication,async()=>{},progress)).toMatchObject({complete:true,rowCount:1});
  expect(await rows()).toMatchObject({dimension:5});expect(await readPrivateConfiguration(publication.key)).toEqual(publication.after);
 });
 it('Zero creates a real empty table in target dimension, without a fake row',async()=>{mode='zero';expect(await reindexHostedRag(input,publication,async()=>{},progress)).toMatchObject({rowCount:0});expect(await rows()).toMatchObject({count:0,dimension:5});});
 it.each(['process','dimension','proof','source','profile-model','profile-extra'])('%s failure preserves old corpus and original private grant',async value=>{
  mode=value;await expect(reindexHostedRag(input,publication,async()=>{},progress)).rejects.toThrow();expect(await rows()).toMatchObject({dimension:3,ids:['old']});expect(await readPrivateConfiguration(publication.key)).toEqual(prior);
 });
 it('A private CAS conflict never overwrites a newer profile',async()=>{mode='private';await expect(reindexHostedRag(input,publication,async()=>{},progress)).rejects.toThrow();expect(await rows()).toMatchObject({dimension:3,ids:['old']});expect((await readPrivateConfiguration<{relay:{port:number}}>(publication.key))?.relay.port).toBe(49153);});
 it('A live native session is not killed or bypassed',async()=>{await fs.writeFile(path.join(store,'neurocenter-session.lock'),JSON.stringify({pid:process.pid,owner:'foreign'}));await expect(reindexHostedRag(input,publication,async()=>{},progress)).rejects.toThrow('Закройте OpenCode');expect(ProbeScope.prototype.command).not.toHaveBeenCalled();});
 it('Authorization revocation before promotion prevents the swap',async()=>{let checks=0;await expect(reindexHostedRag(input,publication,async()=>{if(++checks===2)throw Error('revoked');},progress)).rejects.toThrow('revoked');expect(await rows()).toMatchObject({dimension:3,ids:['old']});expect(await readPrivateConfiguration(publication.key)).toEqual(prior);});
});
