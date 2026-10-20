import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {afterEach,describe,expect,it} from 'vitest';
const source=fileURLToPath(new URL('../',import.meta.url));
const script=`import fs from 'node:fs/promises';import path from 'node:path';
const base=process.env.TEST_SOURCE,temp=process.env.TEST_TEMP;process.env.NEUROCENTER_BRIDGE_HOME=path.join(temp,'private');process.env.NEUROCENTER_URL='http://example.test';
const {setRoot,bindProject,projectBindingId,projectInstanceId}=await import(base+'/src/bridge/workspace.ts');const {hub,jobContext,readState}=await import(base+'/src/bridge/state.ts');
const {saveCompletion,pendingCompletions}=await import(base+'/src/bridge/completions.ts');
const {readPrivateConfiguration,writePrivateConfiguration}=await import(base+'/src/features/local-configuration/private-store.ts');const {profileKey}=await import(base+'/src/features/rag-hosted/profile.ts');
const {setPackage,rehashPackage}=await import(base+'/test/install-set-fixture.ts');const {reserveRestoreIndex}=await import(base+'/src/features/rag-index/restore-lock.ts');const {commitRagRestore,recoverRagRestore,finalizeRagReindex}=await import(base+'/src/features/rag-index/restore-recovery.ts');
const root=path.join(temp,'projects','fixture'),store=path.join(root,'.opencode/rag_db');
if(process.env.TEST_PHASE==='crash'){
 await fs.mkdir(store,{recursive:true});await setRoot(path.dirname(root));await bindProject('test-project',path.basename(root));const bindingId=await projectBindingId('test-project'),instanceId=await projectInstanceId('test-project');await fs.writeFile(path.join(store,'corpus.txt'),'old');
 const pkg=setPackage('journal-rag');pkg.schemaVersion=5;pkg.config.extra={hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1}};rehashPackage(pkg);
 const selection=(dimension,pin)=>({revision:dimension,modelPin:pin,profile:process.env.TEST_ORDER==='jsonb'?{model:'neurocenter/model-fixture/sha256/'+pin,provider:'openai',dimension}:{provider:'openai',model:'neurocenter/model-fixture/sha256/'+pin,dimension},model:{id:'model-fixture'}});
 const old={schemaVersion:2,server:hub(),root,projectId:'test-project',bindingId,instanceId,relay:{port:49152},grants:[{pkg,selection:selection(3,'a'.repeat(64)),key:'1'.repeat(64)}]},next={...old,grants:[{pkg,selection:selection(5,'b'.repeat(64)),key:'2'.repeat(64)}]},key=profileKey(hub(),root,instanceId);
 if(process.env.TEST_PRIOR==='yes')await writePrivateConfiguration(key,old,undefined);await fs.writeFile(path.join(temp,'identity.json'),JSON.stringify({key}));
 const lock=await reserveRestoreIndex(root,store),stage=await fs.mkdtemp(path.join(path.dirname(store),'.neurocenter-rag-restore-'));await fs.writeFile(path.join(stage,'corpus.txt'),'new');await lock.place(stage);
 const rename=fs.rename.bind(fs),remove=fs.rm.bind(fs),point=process.env.TEST_POINT;
 fs.rename=async(from,to)=>{if(point==='before-first'&&from===store)process.kill(process.pid,'SIGKILL');await rename(from,to);if(point==='after-first'&&from===store)process.kill(process.pid,'SIGKILL');if(point==='after-second'&&from===stage&&to===store)process.kill(process.pid,'SIGKILL');};
 fs.rm=async(file,options)=>{if(point==='before-cleanup'&&String(file).endsWith('-previous'))process.kill(process.pid,'SIGKILL');return remove(file,options);};
 const deferred=point.startsWith('deferred-'),job={id:'11111111-1111-4111-8111-111111111111',lease:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
 const commit=()=>commitRagRestore({root,store,stage,lock:lock.raw,overrides:null,identity:{ok:true,projectKey:'test-project',bindingId,instanceId},privateConfiguration:{key,before:process.env.TEST_PRIOR==='yes'?old:null,after:next},...deferred?{deferCompletion:true}:{},result:{ok:true,applied:true,complete:true,remaining:0,fingerprintVersion:1,indexProfile:next.grants[0].selection.profile,snapshotHash:'c'.repeat(64),written:2,sourceCount:2,dimension:5}});
 if(!deferred)await commit();else{
  await jobContext.run(job,async()=>{await commit();await recoverRagRestore(root);});
  let blocked=false;try{await recoverRagRestore(root);}catch{blocked=true;}await fs.writeFile(path.join(temp,'owned.json'),JSON.stringify({ownedRead:true,otherReadBlocked:blocked}));
  if(point!=='deferred-local')await saveCompletion({...job,state:'succeeded',message:'Both local and server verified.',result:{reindex:{complete:true,rowCount:2,snapshotHash:'c'.repeat(64),serverSynced:true}}});
  if(point==='deferred-finalized')await finalizeRagReindex(root,job.id);
  process.kill(process.pid,'SIGKILL');
 }
}else{const {key}=JSON.parse(await fs.readFile(path.join(temp,'identity.json'),'utf8'));if(process.env.TEST_PHASE==='foreign'){const current=await readPrivateConfiguration(key);await writePrivateConfiguration(key,{...current,relay:{port:49153}},current);}let error;try{await recoverRagRestore(root);await recoverRagRestore(root);}catch(cause){error=cause.message;}console.log(JSON.stringify({error,corpus:await fs.readFile(path.join(store,'corpus.txt'),'utf8'),profile:await readPrivateConfiguration(key)??null,completions:await pendingCompletions(),registry:await readState('rag-hosted-connections'),owned:await fs.readFile(path.join(temp,'owned.json'),'utf8').then(JSON.parse).catch(()=>null),leftovers:(await fs.readdir(path.dirname(store))).filter(value=>value.startsWith('.neurocenter-rag-restore-'))}));}`;

describe.skipIf(process.platform==='win32')('Reindex journal: real SIGKILL couples private grant and old corpus',()=>{
 let temporary:string;afterEach(async()=>{if(temporary)await fs.rm(temporary,{recursive:true,force:true});});
 async function run(phase:string,point='',prior='yes',order='canonical'){
  if(!temporary){temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-reindex-journal-')));await fs.writeFile(path.join(temporary,'child.mjs'),script);}
  return new Promise<{signal:NodeJS.Signals|null;output:string}>((resolve,reject)=>{const child=spawn(process.execPath,['--import',path.join(source,'node_modules/tsx/dist/loader.mjs'),path.join(temporary,'child.mjs')],{cwd:source,env:{...process.env,TEST_SOURCE:source,TEST_TEMP:temporary,TEST_PHASE:phase,TEST_POINT:point,TEST_PRIOR:prior,TEST_ORDER:order},stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});child.once('error',reject);child.once('close',(code,signal)=>code&&!signal?reject(Error(errors)):resolve({signal,output}));});
 }
 for(const prior of ['yes','no'])it.each(['before-first','after-first','after-second','before-cleanup'])(`Prior ${prior}, kill at %s`,async point=>{
  temporary='';expect((await run('crash',point,prior)).signal).toBe('SIGKILL');const result=JSON.parse((await run('read','',prior)).output),committed=point==='before-cleanup';expect(result.error).toBeUndefined();expect(result.corpus).toBe(committed?'new':'old');expect(result.profile?.grants[0].selection.profile.dimension??null).toBe(committed?5:prior==='yes'?3:null);expect(result.leftovers).toEqual([]);
 },30000);
 it.each(['after-first','before-cleanup','deferred-local'])('JSONB profile order survives real kill/recovery at %s without changing semantic identity',async point=>{
  temporary='';expect((await run('crash',point,'yes','jsonb')).signal).toBe('SIGKILL');
  const result=JSON.parse((await run('read','','yes','jsonb')).output);expect(result.error).toBeUndefined();
  const committed=point!=='after-first';expect(result.corpus).toBe(committed?'new':'old');expect(result.profile.grants[0].selection.profile.dimension).toBe(committed?5:3);expect(result.leftovers).toEqual([]);
  expect(JSON.parse((await run('read','','yes','jsonb')).output)).toEqual(result);
 },30000);
 it('Foreign private edit is never overwritten during recovery',async()=>{temporary='';await run('crash','after-first');const result=JSON.parse((await run('foreign')).output);expect(result.error).toContain('Приватный профиль изменился');expect(result.profile.relay.port).toBe(49153);expect(result.corpus).toBe('old');},30000);
 it.each(['deferred-local','deferred-success','deferred-finalized'])('Restart at %s preserves committed corpus and reports only durable overall outcome',async point=>{
  temporary='';expect((await run('crash',point)).signal).toBe('SIGKILL');const result=JSON.parse((await run('read')).output);expect(result.error).toBeUndefined();expect(result.corpus).toBe('new');expect(result.profile.grants[0].selection.profile.dimension).toBe(5);expect(result.registry).toHaveLength(1);expect(result.owned).toEqual({ownedRead:true,otherReadBlocked:true});expect(result.leftovers).toEqual([]);
  expect(result.completions).toHaveLength(1);expect(result.completions[0].state).toBe(point==='deferred-local'?'failed':'succeeded');
  expect(result.completions[0].result).toEqual(point==='deferred-local'?{}:{reindex:{complete:true,rowCount:2,snapshotHash:'c'.repeat(64),serverSynced:true}});
  expect(JSON.parse((await run('read')).output)).toEqual(result);
 },30000);
});
