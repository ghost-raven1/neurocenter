import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import contract from '../../services/shared/project-snapshot.cjs';
import {materializeSnapshot} from '../snapshots/materialize.mjs';
import {executeSnapshotVerification} from '../snapshots/runner.mjs';
import {boundedSnapshotResponse,privateSnapshotFile,snapshotControl} from '../snapshots/control.mjs';
import {reserveSnapshotStage,sweepSnapshotStages} from '../snapshots/staging.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),workerId=randomUUID();
async function fixture(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-snapshot-runner-')),payload=Buffer.from([0,255,13,10,123,34,128,0]);
 const manifest={format:'neurocenter.lancedb-snapshot',schemaVersion:1,sdkVersion:'0.29.0',tables:[{name:'documents',version:1,rows:0,schemaSha256:'a'.repeat(64)}],files:[
  {path:'documents.lance/data/part.lance',size:payload.length,sha256:hash(payload),chunks:[{sha256:hash(payload),size:payload.length}]},
  {path:'documents.lance/empty',size:0,sha256:hash(''),chunks:[]},
 ]};
 const claim={snapshotId:randomUUID(),manifest,manifestSha256:contract.snapshotManifestHash(manifest)},calls=[];
 const api=async(route,options={})=>{calls.push({route,options});if(options.bytes)return payload;return {ok:true};};
 return {directory,payload,claim,calls,api,dispose:()=>fs.rm(directory,{recursive:true,force:true})};
}
test('Materialization writes exact opaque binary blocks, canonical manifest and readonly files in owned stage',async()=>{
 const f=await fixture();try{const stage=await fs.mkdtemp(path.join(f.directory,'stage-'));await materializeSnapshot(stage,f.claim,f.api,workerId);
  assert.deepEqual(await fs.readFile(path.join(stage,'database/documents.lance/data/part.lance')),f.payload);assert.equal((await fs.stat(path.join(stage,'database/documents.lance/data/part.lance'))).mode&0o777,0o444);
  assert.equal(await fs.readFile(path.join(stage,'manifest.json'),'utf8'),contract.snapshotCanonicalJson(contract.normalizeSnapshotManifest(f.claim.manifest)));assert.equal(f.calls.length,1);assert.equal(f.calls[0].route,`${f.claim.snapshotId}/${workerId}/blobs/${hash(f.payload)}`);
 }finally{await f.dispose();}
});
test('Manifest hash mismatch, unsafe paths and path aliases fail before fetching/writing database',async()=>{
 const f=await fixture();try{for(const mutate of [
  value=>{value.manifestSha256='b'.repeat(64);},
  value=>{value.manifest.files[0].path='../escape';},
  value=>{value.manifest.files[0].path='documents.lance/../../escape';},
  value=>{value.manifest.files.push({...value.manifest.files[0],path:'DOCUMENTS.LANCE/DATA/PART.LANCE'});},
  value=>{value.manifest.files[1].path='documents.lance/data/part.lance/child';},
 ]){const stage=await fs.mkdtemp(path.join(f.directory,'stage-')),claim=structuredClone(f.claim);mutate(claim);await assert.rejects(materializeSnapshot(stage,claim,f.api,workerId));assert.deepEqual(await fs.readdir(stage),[]);assert.equal(f.calls.length,0);}
 }finally{await f.dispose();}
});
test('Configured byte quota rejects before block fetch and no partial database is created',async()=>{
 const f=await fixture(),previous=process.env.SNAPSHOT_MAX_BYTES;try{process.env.SNAPSHOT_MAX_BYTES='1';const stage=await fs.mkdtemp(path.join(f.directory,'stage-'));await assert.rejects(materializeSnapshot(stage,f.claim,f.api,workerId),/RESOURCE_LIMIT/);assert.deepEqual(await fs.readdir(stage),[]);assert.equal(f.calls.length,0);
 }finally{if(previous===undefined)delete process.env.SNAPSHOT_MAX_BYTES;else process.env.SNAPSHOT_MAX_BYTES=previous;await f.dispose();}
});
test('Corrupt or truncated block cannot reach isolated verification; rejection is FILES_CHANGED and stage is removed',async()=>{
 for(const corrupt of [Buffer.alloc(8),Buffer.alloc(7)]){const f=await fixture();let verified=false;try{
  const api=async(route,options)=>{if(options?.bytes)return corrupt;return f.api(route,options);};
  await assert.rejects(executeSnapshotVerification(f.claim,{directory:f.directory,workerId,imageId:'sha256:'+'a'.repeat(64),api,verify:async()=>{verified=true;}}),/FILES_CHANGED/);
  assert.equal(verified,false);assert.deepEqual(await fs.readdir(f.directory),[]);assert.deepEqual(f.calls.map(row=>({route:row.route,input:row.options.input})),[{route:f.claim.snapshotId+'/reject',input:{workerId,reason:'FILES_CHANGED'}}]);
 }finally{await f.dispose();}}
});
test('Successful worker verifies materialized bytes and only forwards the actual executor result to complete',async()=>{
 const f=await fixture(),result={format:'neurocenter.snapshot-verification/v1',manifestSha256:f.claim.manifestSha256,readRows:0};try{
  const answer=await executeSnapshotVerification(f.claim,{directory:f.directory,workerId,imageId:'sha256:'+'a'.repeat(64),api:f.api,verify:async(stage,image,options)=>{assert.equal(image,'sha256:'+'a'.repeat(64));assert.equal(options.signal.aborted,false);assert.deepEqual(await fs.readFile(path.join(stage,'database/documents.lance/data/part.lance')),f.payload);return result;}});
  assert.deepEqual(answer,{status:'VERIFIED',snapshotId:f.claim.snapshotId});assert.equal(f.calls.at(-1).route,f.claim.snapshotId+'/complete');assert.deepEqual(f.calls.at(-1).options.input,{workerId,result});assert.equal(f.calls.at(-1).options.signal.aborted,false);assert.deepEqual(await fs.readdir(f.directory),[]);
 }finally{await f.dispose();}
});
test('Unknown verifier failure uses safe constant rejection and removes owned stage without private error leakage',async()=>{
 const f=await fixture();try{await assert.rejects(executeSnapshotVerification(f.claim,{directory:f.directory,workerId,imageId:'sha256:'+'a'.repeat(64),api:f.api,verify:async()=>{throw Error('/private/operator/key secret-provider-token');}}));
  assert.equal(f.calls.at(-1).route,f.claim.snapshotId+'/reject');assert.deepEqual(f.calls.at(-1).options.input,{workerId,reason:'STORAGE_UNAVAILABLE'});assert.deepEqual(await fs.readdir(f.directory),[]);
 }finally{await f.dispose();}
});
test('External cancellation aborts verification, sends no completion/rejection and removes owned stage',async()=>{
 const f=await fixture(),controller=new AbortController();let entered;const started=new Promise(resolve=>{entered=resolve;});try{
  const run=executeSnapshotVerification(f.claim,{directory:f.directory,workerId,imageId:'sha256:'+'a'.repeat(64),api:f.api,signal:controller.signal,verify:async(_stage,_image,{signal})=>{entered();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  await started;controller.abort(Error('RUNNER_STOPPED'));await assert.rejects(run,/RUNNER_STOPPED/);assert.equal(f.calls.some(row=>/\/(complete|reject)$/.test(row.route)),false);assert.deepEqual(await fs.readdir(f.directory),[]);
 }finally{await f.dispose();}
});
test('A stopped verification can materialize and finish the same accepted bytes on the next execution',async()=>{
 const f=await fixture(),controller=new AbortController();let entered;const started=new Promise(resolve=>{entered=resolve;});
 try{
  const running=executeSnapshotVerification(f.claim,{directory:f.directory,workerId,imageId:'sha256:'+'a'.repeat(64),api:f.api,signal:controller.signal,
   verify:async(_stage,_image,{signal})=>{entered();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  await started;controller.abort(Error('RUNNER_STOPPED'));await assert.rejects(running,/RUNNER_STOPPED/);
  assert.equal(f.calls.some(row=>/\/(complete|reject)$/.test(row.route)),false);
  const resumed=await executeSnapshotVerification(f.claim,{directory:f.directory,workerId,imageId:'sha256:'+'a'.repeat(64),api:f.api,
   verify:async stage=>{assert.deepEqual(await fs.readFile(path.join(stage,'database/documents.lance/data/part.lance')),f.payload);return {readRows:0};}});
  assert.equal(resumed.status,'VERIFIED');assert.equal(f.calls.at(-1).route,f.claim.snapshotId+'/complete');assert.equal(f.calls.some(row=>row.route.endsWith('/reject')),false);
  assert.deepEqual(await fs.readdir(f.directory),[]);
 }finally{await f.dispose();}
});
test('Lease renewal refusal cancels the in-flight verifier rather than signing a late result',{timeout:45000},async()=>{
 const f=await fixture();let entered;const started=new Promise(resolve=>{entered=resolve;});
 try{const api=(route,options)=>route.endsWith('/renew')?Promise.reject(Error('LEASE_REVOKED')):f.api(route,options);
  const run=executeSnapshotVerification(f.claim,{directory:f.directory,workerId,imageId:'sha256:'+'a'.repeat(64),api,verify:async(_stage,_image,{signal})=>{entered();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  await started;await assert.rejects(run,/LEASE_REVOKED/);assert.equal(f.calls.some(row=>/\/(complete|reject)$/.test(row.route)),false);assert.deepEqual(await fs.readdir(f.directory),[]);
 }finally{await f.dispose();}
});
test('A lost completion ACK never reruns verification within the worker',async()=>{
 const f=await fixture();let verifies=0,completes=0;try{const api=(route,options)=>{if(route.endsWith('/complete')){completes++;throw Error('LOST_ACK');}return f.api(route,options);};
  await assert.rejects(executeSnapshotVerification(f.claim,{directory:f.directory,workerId,imageId:'sha256:'+'a'.repeat(64),api,verify:async()=>{verifies++;return {readRows:0};}}),/LOST_ACK/);assert.equal(verifies,1);assert.equal(completes,1);assert.deepEqual(await fs.readdir(f.directory),[]);
 }finally{await f.dispose();}
});
test('Control client rejects unsafe origins/routes and preserves actual binary HTTP response bytes',async()=>{
 const token='a'.repeat(64);for(const origin of ['http://example.test','https://u:p@example.test','https://example.test/private','https://example.test/?q=1','file:///tmp/x'])assert.throws(()=>snapshotControl(origin,token),/UNSAFE_CONTROL/);
 const requests=[],payload=Buffer.from([0,255,13,10,123]);const server=createServer((req,res)=>{requests.push({url:req.url,method:req.method,headers:req.headers});res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':payload.length});res.end(payload);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{const api=snapshotControl('http://127.0.0.1:'+server.address().port,token);await assert.rejects(api('../escape',{bytes:true}),/UNSAFE_CONTROL_ROUTE/);const body=await api('claim/blobs/abc',{bytes:true});assert.deepEqual(body,payload);assert.equal(requests[0].headers['x-neurocenter-snapshot-verifier'],token);assert.equal(requests[0].method,'GET');assert.equal(requests[0].url,'/internal/project-snapshots/verifier/claim/blobs/abc');
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('Bounded control reads cancel over-limit declared and actual chunked responses',async()=>{
 let cancelled=false;const response=()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(5));controller.enqueue(new Uint8Array(5));},cancel(){cancelled=true;}}));
 await assert.rejects(boundedSnapshotResponse(response(),8),/RESPONSE_LIMIT/);assert.equal(cancelled,true);
 cancelled=false;const declared=response();declared.headers.set('content-length','99');await assert.rejects(boundedSnapshotResponse(declared,8),/RESPONSE_LIMIT/);assert.equal(cancelled,true);
});
test('Operator secret reader rejects unsafe mode, symlink, hardlink and oversized files',async()=>{
 const f=await fixture();try{const filename=path.join(f.directory,'token');await fs.writeFile(filename,'a'.repeat(64),{mode:0o600});assert.equal((await privateSnapshotFile(filename)).length,64);
  await fs.chmod(filename,0o644);await assert.rejects(privateSnapshotFile(filename),/UNSAFE_OPERATOR_FILE/);await fs.chmod(filename,0o600);
  await fs.symlink(filename,filename+'.link');await assert.rejects(privateSnapshotFile(filename+'.link'));await fs.link(filename,filename+'.hard');await assert.rejects(privateSnapshotFile(filename),/UNSAFE_OPERATOR_FILE/);await fs.rm(filename+'.hard');await assert.rejects(privateSnapshotFile(filename,32),/UNSAFE_OPERATOR_FILE/);
 }finally{await f.dispose();}
});
async function stageChild(directory,claim,environment={}){
 const code=`import {reserveSnapshotStage} from ${JSON.stringify(new URL('../snapshots/staging.mjs',import.meta.url).href)};try{const saved=await reserveSnapshotStage(process.env.SNAPSHOT_TEST_DIRECTORY,JSON.parse(process.env.SNAPSHOT_TEST_CLAIM));process.send({stage:saved.stage,reservedBytes:saved.reservedBytes});process.once('message',async()=>{await saved.release();process.disconnect();});}catch(error){process.send({error:error.message});process.disconnect();}`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,...environment,SNAPSHOT_TEST_DIRECTORY:directory,SNAPSHOT_TEST_CLAIM:JSON.stringify(claim)},stdio:['ignore','ignore','pipe','ipc']});
 const closed=new Promise((resolve,reject)=>{child.once('close',code=>resolve(code));child.once('error',reject);});
 const ready=await new Promise((resolve,reject)=>{let answered=false;child.once('message',value=>{answered=true;resolve(value);});child.once('error',reject);child.once('close',()=>{if(!answered)reject(Error('Owned fixture child exited before reservation'));});});
 return {child,ready,closed,dispose:async()=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await closed;}};
}
test('SIGKILL leaves durable owner evidence; startup sweeps only the now-dead owned stage',{timeout:8000},async()=>{
 const f=await fixture();let owned;try{owned=await stageChild(f.directory,f.claim);assert.ok(owned.ready.stage);assert.equal((await fs.stat(path.join(owned.ready.stage,'.snapshot-owner.json'))).mode&0o777,0o600);
  assert.deepEqual(await sweepSnapshotStages(f.directory),{removed:0,retained:1,unknown:0});owned.child.kill('SIGKILL');await owned.closed;
  assert.deepEqual(await sweepSnapshotStages(f.directory),{removed:1,retained:0,unknown:0});assert.deepEqual(await fs.readdir(f.directory),[]);
 }finally{await owned?.dispose();await f.dispose();}
});
test('Foreign/malformed/symlink directories are never removed or admitted as quota-free space',async()=>{
 const f=await fixture(),outside=await fs.mkdtemp(path.join(os.tmpdir(),'nc-snapshot-foreign-'));let reservation;try{
  reservation=await reserveSnapshotStage(f.directory,f.claim);const file=path.join(reservation.stage,'.snapshot-owner.json'),saved=JSON.parse(await fs.readFile(file,'utf8'));
  await fs.writeFile(file,JSON.stringify({...saved,host:'foreign-host'}));await fs.mkdir(path.join(f.directory,'snapshot-BAD123'));await fs.writeFile(path.join(f.directory,'snapshot-BAD123','keep'),'foreign bytes');await fs.symlink(outside,path.join(f.directory,'snapshot-LNK123'));
  const before=(await fs.readdir(f.directory)).sort();assert.deepEqual(await sweepSnapshotStages(f.directory),{removed:0,retained:0,unknown:3});await assert.rejects(reserveSnapshotStage(f.directory,f.claim),/RESOURCE_LIMIT/);assert.deepEqual((await fs.readdir(f.directory)).sort(),before);assert.equal(await fs.readFile(path.join(f.directory,'snapshot-BAD123','keep'),'utf8'),'foreign bytes');assert.equal((await fs.lstat(path.join(f.directory,'snapshot-LNK123'))).isSymbolicLink(),true);
  await fs.writeFile(file,JSON.stringify(saved));await reservation.release();reservation=undefined;
 }finally{await f.dispose();await fs.rm(outside,{recursive:true,force:true});}
});
test('A live or reused PID reservation is retained; staged total quota refuses new payload destinations',async()=>{
 const f=await fixture(),old=process.env.SNAPSHOT_STAGING_MAX_BYTES;let reservation;try{
  reservation=await reserveSnapshotStage(f.directory,f.claim);process.env.SNAPSHOT_STAGING_MAX_BYTES=String(reservation.reservedBytes*2-1);assert.deepEqual(await sweepSnapshotStages(f.directory),{removed:0,retained:1,unknown:0});await assert.rejects(reserveSnapshotStage(f.directory,f.claim),/RESOURCE_LIMIT/);assert.deepEqual(await fs.readdir(f.directory),[path.basename(reservation.stage)]);assert.equal((await fs.stat(reservation.stage)).isDirectory(),true);await reservation.release();reservation=undefined;
 }finally{if(old===undefined)delete process.env.SNAPSHOT_STAGING_MAX_BYTES;else process.env.SNAPSHOT_STAGING_MAX_BYTES=old;await f.dispose();}
});
test('Empty files and deep directory metadata cannot bypass the staging byte reservation',async()=>{
 const f=await fixture(),old=process.env.SNAPSHOT_STAGING_MAX_BYTES;try{
  const claim=structuredClone(f.claim);claim.manifest.files=Array.from({length:1000},(_,index)=>({path:`documents.lance/empty-${index}`,size:0,sha256:hash(''),chunks:[]}));claim.manifestSha256=contract.snapshotManifestHash(claim.manifest);process.env.SNAPSHOT_STAGING_MAX_BYTES=String(512*1024);
  await assert.rejects(reserveSnapshotStage(f.directory,claim),/RESOURCE_LIMIT/);assert.deepEqual(await fs.readdir(f.directory),[]);
 }finally{if(old===undefined)delete process.env.SNAPSHOT_STAGING_MAX_BYTES;else process.env.SNAPSHOT_STAGING_MAX_BYTES=old;await f.dispose();}
});
test('Competing real processes cannot both reserve more than the staging quota',{timeout:8000},async()=>{
 const f=await fixture();let first,second;try{
  const claim=structuredClone(f.claim);claim.manifest.files[0].size=8*1024**2;claim.manifest.files[0].chunks[0].size=8*1024**2;claim.manifestSha256=contract.snapshotManifestHash(claim.manifest);
  [first,second]=await Promise.all([stageChild(f.directory,claim,{SNAPSHOT_STAGING_MAX_BYTES:String(12*1024**2)}),stageChild(f.directory,claim,{SNAPSHOT_STAGING_MAX_BYTES:String(12*1024**2)})]);
  const accepted=[first,second].filter(value=>!!value.ready.stage);assert.ok(accepted.length<=1);for(const current of [first,second])if(!current.ready.stage)assert.equal(current.ready.error,'RESOURCE_LIMIT');
  for(const current of accepted){current.child.send('release');await current.closed;}assert.deepEqual(await fs.readdir(f.directory),[]);
 }finally{await first?.dispose();await second?.dispose();await f.dispose();}
});
test('Whole execution deadline includes materialization; timeout rejects RESOURCE_LIMIT and clears its reservation',{timeout:4000},async()=>{
 const f=await fixture();let verifies=0;try{
  const api=(route,options)=>options?.bytes?new Promise((_resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});}):f.api(route,options);
  await assert.rejects(executeSnapshotVerification(f.claim,{directory:f.directory,workerId,imageId:'sha256:'+'a'.repeat(64),api,timeout:100,verify:async()=>{verifies++;}}),/RESOURCE_LIMIT/);
  assert.equal(verifies,0);assert.deepEqual(f.calls.at(-1).options.input,{workerId,reason:'RESOURCE_LIMIT'});assert.equal(f.calls.at(-1).route,f.claim.snapshotId+'/reject');assert.deepEqual(await fs.readdir(f.directory),[]);
 }finally{await f.dispose();}
});
async function dockerFixture(mode,timeout=1000){
 const f=await fixture(),bin=path.join(f.directory,'bin'),log=path.join(f.directory,'docker.jsonl'),stage=path.join(f.directory,'stage');await fs.mkdir(bin);await fs.mkdir(stage);
 await fs.writeFile(path.join(bin,'docker'),`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.SNAPSHOT_TEST_LOG,JSON.stringify(args)+'\\n');if(args[0]==='image'){console.log('sha256:'+'a'.repeat(64));}else if(args[0]==='run'){fs.writeFileSync(args[args.indexOf('--cidfile')+1],'c'.repeat(64));if(process.env.SNAPSHOT_TEST_MODE==='hang')setInterval(()=>{},1000);else if(process.env.SNAPSHOT_TEST_MODE==='large')process.stdout.write('x'.repeat(300000));else console.log(JSON.stringify({readRows:7}));}\n`,{mode:0o700});
 const code=`import {runSnapshotVerifier,snapshotVerifierImage} from ${JSON.stringify(new URL('../snapshots/docker-verifier.mjs',import.meta.url).href)};const image=await snapshotVerifierImage('owned-test-image');try{console.log(JSON.stringify({result:await runSnapshotVerifier(process.env.SNAPSHOT_TEST_STAGE,image,{timeout:${timeout}})}));}catch(error){console.log(JSON.stringify({error:error.message,code:error.code}));}`;
 const output=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{env:{...process.env,PATH:bin,SNAPSHOT_TEST_MODE:mode,SNAPSHOT_TEST_LOG:log,SNAPSHOT_TEST_STAGE:stage},timeout:5000,maxBuffer:1024*1024});
 const calls=(await fs.readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),result=JSON.parse(output.stdout.trim());return {...f,calls,result,remaining:await fs.readdir(f.directory),stageRemaining:await fs.readdir(stage)};
}
test('Isolated Docker invocation pins immutable image, drops privileges/network, and cleans exact owned container',async()=>{
 const f=await dockerFixture('ok');try{assert.deepEqual(f.result,{result:{readRows:7}});const run=f.calls.find(args=>args[0]==='run');for(const token of ['--rm','--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','--memory','--cpus','--tmpfs'])assert.ok(run.includes(token));assert.equal(run.at(-1),'sha256:'+'a'.repeat(64));assert.match(run[run.indexOf('--mount')+1],/dst=\/snapshot,readonly$/);assert.equal(run[run.indexOf('--tmpfs')+1],'/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777');assert.equal(path.dirname(run[run.indexOf('--cidfile')+1]),path.join(f.directory,'stage'));assert.deepEqual(f.calls.at(-1),['rm','-f','c'.repeat(64)]);assert.equal(f.remaining.some(name=>name.endsWith('.cid')),false);assert.deepEqual(f.stageRemaining,[]);
 }finally{await f.dispose();}
});
test('Docker output overflow is bounded and still removes the owned container',async()=>{const f=await dockerFixture('large');try{assert.equal(f.result.error,'RESOURCE_LIMIT');assert.deepEqual(f.calls.at(-1),['rm','-f','c'.repeat(64)]);assert.deepEqual(f.stageRemaining,[]);}finally{await f.dispose();}});
test('Docker deadline is a resource-limit rejection and cleans the owned container',{timeout:8000},async()=>{const f=await dockerFixture('hang',250);try{assert.equal(f.result.error,'RESOURCE_LIMIT');assert.deepEqual(f.calls.at(-1),['rm','-f','c'.repeat(64)]);assert.equal(f.remaining.some(name=>name.endsWith('.cid')),false);assert.deepEqual(f.stageRemaining,[]);}finally{await f.dispose();}});
