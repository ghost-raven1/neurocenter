import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import cleanup from '../../services/shared/bridge-update-cleanup.cjs';

const {OWNER_FILE,CAPABILITY_FILE,RUNTIME_USE_ENTRYPOINTS,DEFAULT_CLEANUP_POLICY,normalizeCleanupPolicy,controlRootForInstallRoot,
 acquireRuntimeUseLease,acquireForEntrypoint,writeSuccessfulBackupReceipt,cleanupSuccessfulBackups}=cleanup;
const {writeInstalledRuntimeReceipt}=cleanup;
const DAY=86400000,NOW=2000000000000;
async function runtime(root,installRoot,value='original',{baseline=true}={}){
 const target=root;root=await fs.mkdtemp(path.join(path.dirname(root),'.fixture-stage-'));
 await fs.mkdir(path.join(root,'dist'),{recursive:true});
 await fs.mkdir(path.join(root,'bin'),{recursive:true});await fs.mkdir(path.join(root,'node_modules','fixture'),{recursive:true});
 await fs.writeFile(path.join(root,OWNER_FILE),JSON.stringify({schemaVersion:1,installRoot}));
 await fs.writeFile(path.join(root,CAPABILITY_FILE),JSON.stringify({schemaVersion:1,entrypoints:RUNTIME_USE_ENTRYPOINTS}));
 await fs.writeFile(path.join(root,'dist/index.js'),value);await fs.writeFile(path.join(root,'bin/node'),'own fixture node');
 await fs.writeFile(path.join(root,'node_modules/fixture/index.js'),'own fixture dependency');await fs.mkdir(path.join(root,'empty'));
 if(baseline)await writeInstalledRuntimeReceipt({installRoot,runtimeRoot:root});await fs.rename(root,target);
}
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'bridge-cleanup-'))),installRoot=path.join(root,'bridge');
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await runtime(installRoot,installRoot,'current');
 const backupRoots=[path.join(root,'.neurocenter-previous.Abc123'),path.join(root,'.neurocenter-previous-.neurocenter-dev-install-Abcdef'),
  path.join(root,'bridge.previous-11111111-1111-4111-8111-111111111111')];
 async function backups(){
  for(const [index,backupRoot] of backupRoots.entries()){
   await runtime(backupRoot,installRoot,'backup-'+index);
   assert.equal((await writeSuccessfulBackupReceipt({installRoot,backupRoot,completedAt:NOW-(20-index)*DAY})).eligible,true);
  }
 }
 return {root,installRoot,backupRoots,backups,run:options=>cleanupSuccessfulBackups({installRoot,now:NOW,...options})};
}
async function leaseFile(installRoot,lease){
 const root=await controlRootForInstallRoot(installRoot),directory=path.join(root,'leases',lease.identity.dev+'-'+lease.identity.ino);
 return path.join(directory,(await fs.readdir(directory))[0]);
}
test('Cleanup policy uses enabled keep-two age-seven defaults and rejects ambiguous or destructive settings',()=>{
 assert.deepEqual(normalizeCleanupPolicy(),{enabled:true,keepPrevious:2,minAgeDays:7});assert.ok(Object.isFrozen(DEFAULT_CLEANUP_POLICY));
 for(const value of [{},null,{enabled:true,keepPrevious:0,minAgeDays:7},{enabled:true,keepPrevious:11,minAgeDays:7},
  {enabled:true,keepPrevious:2,minAgeDays:0},{enabled:true,keepPrevious:2,minAgeDays:91},{...DEFAULT_CLEANUP_POLICY,extra:true}])assert.throws(()=>normalizeCleanupPolicy(value));
});
test('A third old successful backup is actually removed; two verified rollbacks, current and unmarked folders survive',async t=>{
 const f=await fixture(t);await f.backups();const unmarked=path.join(f.root,'.neurocenter-previous.Xyz789');await runtime(unmarked,f.installRoot);
 const result=await f.run();assert.deepEqual(result.removed,[f.backupRoots[0]]);assert.deepEqual(result.warnings,[]);
 await assert.rejects(fs.access(f.backupRoots[0]),{code:'ENOENT'});
 for(const root of [f.installRoot,unmarked,...f.backupRoots.slice(1)])assert.equal(await fs.readFile(path.join(root,'bin/node'),'utf8'),'own fixture node');
 assert.equal(await fs.readFile(path.join(f.installRoot,'dist/index.js'),'utf8'),'current');
 assert.equal(result.kept.filter(item=>item.reason==='retained-rollback').length,2);
});
test('Disabled cleanup and minimum age preserve complete backups without calling authorization',async t=>{
 const f=await fixture(t);await f.backups();let called=0;
 assert.deepEqual(await f.run({policy:{...DEFAULT_CLEANUP_POLICY,enabled:false},beforeDelete:async()=>{called++;}}),{removed:[],kept:[],warnings:[]});
 const result=await f.run({now:NOW-18*DAY});assert.deepEqual(result.removed,[]);assert.ok(result.kept.some(item=>item.reason==='too-recent'));assert.equal(called,0);
});
test('An inode-bound live lease survives rename, protects its old backup and releases without touching the replacement',async t=>{
 const f=await fixture(t),lease=await acquireRuntimeUseLease(f.installRoot,{required:true});
 await fs.rename(f.installRoot,f.backupRoots[0]);await runtime(f.installRoot,f.installRoot,'replacement');
 await writeSuccessfulBackupReceipt({installRoot:f.installRoot,backupRoot:f.backupRoots[0],completedAt:NOW-30*DAY});
 for(const [index,backupRoot] of f.backupRoots.slice(1).entries()){
  await runtime(backupRoot,f.installRoot);await writeSuccessfulBackupReceipt({installRoot:f.installRoot,backupRoot,completedAt:NOW-(10-index)*DAY});
 }
 const protectedResult=await f.run();assert.deepEqual(protectedResult.removed,[]);assert.ok(protectedResult.kept.some(item=>item.path===f.backupRoots[0]&&item.reason==='runtime-in-use'));
 await lease.release();await lease.release();assert.deepEqual((await f.run()).removed,[f.backupRoots[0]]);
 assert.equal(await fs.readFile(path.join(f.installRoot,'dist/index.js'),'utf8'),'replacement');
});
for(const state of ['unknown','dead','malformed'])test('Runtime lease state '+state+' only authorizes deletion for proven ESRCH',async t=>{
 const f=await fixture(t);await f.backups();const lease=await acquireRuntimeUseLease(f.backupRoots[0],{required:true}),filename=await leaseFile(f.installRoot,lease),original=await fs.readFile(filename);
 const pid=2147483646,record=JSON.parse(original);record.pid=pid;await fs.writeFile(filename,state==='malformed'?'{}':JSON.stringify(record));
 const kill=process.kill.bind(process);t.mock.method(process,'kill',(value,signal)=>{if(value===pid)throw Object.assign(Error('owned fixture probe'),{code:state==='dead'?'ESRCH':'EPERM'});return kill(value,signal);});
 const result=await f.run();assert.deepEqual(result.removed,state==='dead'?[f.backupRoots[0]]:[]);
 await fs.writeFile(filename,original);await lease.release();
});
for(const mutation of ['content','mode','special-mode','symlink','hardlink','replaced'])test('A '+mutation+' modified backup is preserved without weakening current or rollback copies',async t=>{
 if(mutation==='special-mode'&&process.platform==='win32'){t.skip('POSIX special mode bits are not available.');return;}
 const f=await fixture(t);await f.backups();const target=path.join(f.backupRoots[0],'node_modules/fixture/index.js');
 if(mutation==='content')await fs.appendFile(target,'manual bytes');
 if(mutation==='mode')await fs.chmod(target,0o700);
 if(mutation==='special-mode')await fs.chmod(target,0o4644);
 if(mutation==='symlink')await fs.symlink(path.join(f.installRoot,'bin/node'),path.join(f.backupRoots[0],'alias'));
 if(mutation==='hardlink')await fs.link(target,path.join(f.root,'manual-copy'));
 if(mutation==='replaced'){await fs.rename(f.backupRoots[0],path.join(f.root,'replaced-original'));await runtime(f.backupRoots[0],f.installRoot,'backup-0');}
 const result=await f.run();assert.deepEqual(result.removed,[]);assert.ok(result.warnings.length);await fs.access(f.backupRoots[0]);
 assert.equal(await fs.readFile(path.join(f.installRoot,'dist/index.js'),'utf8'),'current');
});
test('The final verified rollback survives even when every newer receipt points at a modified backup',async t=>{
 const f=await fixture(t);await f.backups();for(const root of f.backupRoots.slice(1))await fs.appendFile(path.join(root,'dist/index.js'),'manual');
 const result=await f.run({policy:{...DEFAULT_CLEANUP_POLICY,keepPrevious:1}});assert.deepEqual(result.removed,[]);
 assert.ok(result.kept.some(item=>item.path===f.backupRoots[0]&&item.reason==='retained-rollback'));
});
test('A missing owner or incomplete capability never makes legacy or arbitrary paths eligible',async t=>{
 const f=await fixture(t),backupRoot=f.backupRoots[0];await runtime(backupRoot,f.installRoot);await fs.unlink(path.join(backupRoot,OWNER_FILE));
 assert.deepEqual(await writeSuccessfulBackupReceipt({installRoot:f.installRoot,backupRoot}),{eligible:false,reason:'legacy-runtime'});
 await assert.rejects(acquireRuntimeUseLease(backupRoot));await assert.rejects(acquireRuntimeUseLease(backupRoot,{required:true}));
 await fs.writeFile(path.join(backupRoot,OWNER_FILE),JSON.stringify({schemaVersion:1,installRoot:f.installRoot}));
 await fs.writeFile(path.join(backupRoot,CAPABILITY_FILE),JSON.stringify({schemaVersion:1,entrypoints:RUNTIME_USE_ENTRYPOINTS.slice(0,-1)}));
 await assert.rejects(writeSuccessfulBackupReceipt({installRoot:f.installRoot,backupRoot}));await assert.rejects(acquireRuntimeUseLease(backupRoot));
 await assert.rejects(writeSuccessfulBackupReceipt({installRoot:f.installRoot,backupRoot:f.installRoot}));
 const foreign=path.join(f.root,'foreign');await runtime(foreign,f.installRoot);await assert.rejects(writeSuccessfulBackupReceipt({installRoot:f.installRoot,backupRoot:foreign}));
 assert.deepEqual((await f.run()).removed,[]);
});
test('Every declared bootstrap acquires a lease; unknown imports and ordinary staging have distinct outcomes',async t=>{
 const f=await fixture(t);
 for(const entrypoint of RUNTIME_USE_ENTRYPOINTS){const lease=await acquireForEntrypoint(pathToFileURL(path.join(f.installRoot,entrypoint)));assert.ok(lease);await lease.release();}
 await assert.rejects(acquireForEntrypoint(pathToFileURL(path.join(f.installRoot,'dist/foreign.js'))));
 const stage=path.join(f.root,'stage');await fs.mkdir(path.join(stage,'dist'),{recursive:true});
 assert.equal(await acquireForEntrypoint(path.join(stage,'dist/index.js')),undefined);
 await assert.rejects(acquireForEntrypoint(path.join(stage,'dist/index.js'),{required:true}));
});
for(const denial of [1,2])test('Fresh authorization denial at destructive boundary '+denial+' preserves all bytes and current runtime',async t=>{
 const f=await fixture(t);await f.backups();let checks=0;
 const result=await f.run({beforeDelete:async()=>{if(++checks===denial)throw Error('fixture authorization revoked');}});
 assert.equal(checks,denial);assert.deepEqual(result.removed,[]);assert.ok(result.warnings.length);
 assert.equal(await fs.readFile(path.join(f.backupRoots[0],'dist/index.js'),'utf8'),'backup-0');
 assert.equal(await fs.readFile(path.join(f.installRoot,'dist/index.js'),'utf8'),'current');
 assert.deepEqual((await f.run()).removed,[f.backupRoots[0]]);
});
test('A partial deletion records a tombstone, never rolls back current and retries only unchanged remaining bytes',async t=>{
 const f=await fixture(t);await f.backups();const rm=fs.rm.bind(fs);let intercepted=false;
 const mocked=t.mock.method(fs,'rm',async(filename,options)=>{
  if(filename===f.backupRoots[0]&&!intercepted){intercepted=true;await fs.unlink(path.join(filename,OWNER_FILE));await fs.unlink(path.join(filename,CAPABILITY_FILE));throw Object.assign(Error('fixture disk interruption'),{code:'EIO'});}
  return rm(filename,options);
 });
 const failed=await f.run();mocked.mock.restore();assert.equal(intercepted,true);assert.deepEqual(failed.removed,[]);assert.ok(failed.warnings.length);
 const controlRoot=await controlRootForInstallRoot(f.installRoot),receipts=await fs.readdir(path.join(controlRoot,'receipts'));
 const records=await Promise.all(receipts.map(name=>fs.readFile(path.join(controlRoot,'receipts',name),'utf8').then(JSON.parse)));
 assert.equal(records.find(record=>record.backup.root===f.backupRoots[0]).state,'deleting');
 assert.equal(await fs.readFile(path.join(f.installRoot,'dist/index.js'),'utf8'),'current');
 let main=false;await assert.rejects(acquireForEntrypoint(pathToFileURL(path.join(f.backupRoots[0],'dist/index.js'))).then(()=>{main=true;}));assert.equal(main,false);
 assert.deepEqual((await f.run()).removed,[f.backupRoots[0]]);
});
test('A tombstoned remainder with new manual bytes is preserved rather than recursively retried',async t=>{
 const f=await fixture(t);await f.backups();const rm=fs.rm.bind(fs);
 const mocked=t.mock.method(fs,'rm',async(filename,options)=>{if(filename===f.backupRoots[0])throw Error('fixture deletion unavailable');return rm(filename,options);});
 await f.run();mocked.mock.restore();await fs.writeFile(path.join(f.backupRoots[0],'manual.txt'),'new retained manual data');
 const result=await f.run();assert.deepEqual(result.removed,[]);assert.equal(await fs.readFile(path.join(f.backupRoots[0],'manual.txt'),'utf8'),'new retained manual data');
});
test('GC gate before reader registration rejects before main and removes only the rejected readers own lease',async t=>{
 const f=await fixture(t);await f.backups();let started=false,main=false;
 const result=await f.run({beforeDelete:async()=>{
  if(started)return;started=true;
  await assert.rejects(acquireForEntrypoint(pathToFileURL(path.join(f.backupRoots[0],'dist/index.js')),{required:true}).then(()=>{main=true;}),/cleanup is in progress/);
 }});
 assert.equal(main,false);assert.deepEqual(result.removed,[f.backupRoots[0]]);
});
test('Durable reader lease published before the GC gate protects its inode before registration returns',async t=>{
 const f=await fixture(t);await f.backups();const root=await controlRootForInstallRoot(f.installRoot),stat=await fs.lstat(f.backupRoots[0],{bigint:true});
 const gate=path.join(root,'locks','gc-runtime-'+stat.dev+'-'+stat.ino+'.json'),lstat=fs.lstat.bind(fs);let pause=true,arrive,proceed;
 const arrived=new Promise(resolve=>{arrive=resolve;}),allowed=new Promise(resolve=>{proceed=resolve;});
 t.mock.method(fs,'lstat',async(filename,...args)=>{if(filename===gate&&pause){pause=false;arrive();await allowed;}return lstat(filename,...args);});
 const registration=acquireRuntimeUseLease(f.backupRoots[0],{required:true});await arrived;
 const result=await f.run();assert.deepEqual(result.removed,[]);assert.ok(result.kept.some(item=>item.path===f.backupRoots[0]&&item.reason==='runtime-in-use'));
 proceed();const lease=await registration;await lease.release();assert.deepEqual((await f.run()).removed,[f.backupRoots[0]]);
});
test('Current startup and release ignore stale global and inode locks while backup readers fail closed on their GC gate',async t=>{
 const f=await fixture(t);await f.backups();const root=await controlRootForInstallRoot(f.installRoot),current=await fs.lstat(f.installRoot,{bigint:true}),backup=await fs.lstat(f.backupRoots[0],{bigint:true});
 const bytes='stale lock preserved',global=path.join(root,'lock.json'),old=path.join(root,'locks','runtime-'+current.dev+'-'+current.ino+'.json');
 const currentGate=path.join(root,'locks','gc-runtime-'+current.dev+'-'+current.ino+'.json'),backupGate=path.join(root,'locks','gc-runtime-'+backup.dev+'-'+backup.ino+'.json');
 for(const filename of [global,old,currentGate,backupGate])await fs.writeFile(filename,bytes);
 const lease=await acquireForEntrypoint(pathToFileURL(path.join(f.installRoot,'dist/features/opencode-providers/ollama-sdk.js')),{required:true});assert.ok(lease);
 await Promise.all([lease.release(),lease.release()]);await assert.rejects(acquireRuntimeUseLease(f.backupRoots[0],{required:true}),/cleanup is in progress/);
 for(const filename of [global,old,currentGate,backupGate])assert.equal(await fs.readFile(filename,'utf8'),bytes);
 await fs.unlink(global);const result=await f.run();assert.deepEqual(result.removed,[]);await fs.access(f.backupRoots[0]);
});
test('Current runtime starts while authorization pauses cleanup of a different backup inode',async t=>{
 const f=await fixture(t);await f.backups();let lease,checks=0;
 const result=await f.run({beforeDelete:async()=>{
  if(++checks!==1)return;lease=await acquireForEntrypoint(pathToFileURL(path.join(f.installRoot,'dist/index.js')),{required:true});assert.ok(lease);
 }});
 assert.equal(checks,2);assert.deepEqual(result.removed,[f.backupRoots[0]]);
 assert.equal(await fs.readFile(path.join(f.installRoot,'dist/index.js'),'utf8'),'current');await lease.release();
});
test('A newly started foreign current-runtime consumer preserves the whole lineage while its startup succeeds',async t=>{
 const f=await fixture(t);await f.backups();let lease,filename,original,checks=0;const pid=2147483646,kill=process.kill.bind(process);
 t.mock.method(process,'kill',(value,signal)=>{if(value===pid)throw Object.assign(Error('fixture inaccessible consumer'),{code:'EPERM'});return kill(value,signal);});
 const result=await f.run({beforeDelete:async()=>{
  if(++checks!==1)return;lease=await acquireForEntrypoint(pathToFileURL(path.join(f.installRoot,'dist/index.js')),{required:true});assert.ok(lease);
  filename=await leaseFile(f.installRoot,lease);original=await fs.readFile(filename);const record=JSON.parse(original);record.pid=pid;await fs.writeFile(filename,JSON.stringify(record));
 }});
 assert.equal(checks,2);assert.deepEqual(result.removed,[]);assert.ok(result.warnings.length);await fs.access(f.backupRoots[0]);
 await fs.writeFile(filename,original);await lease.release();assert.deepEqual((await f.run()).removed,[f.backupRoots[0]]);
});
test('An own-process lease to a different old runtime preserves the lineage too',async t=>{
 const f=await fixture(t);await f.backups();const lease=await acquireRuntimeUseLease(f.backupRoots[1],{required:true});
 const result=await f.run();assert.deepEqual(result.removed,[]);assert.ok(result.kept.some(item=>item.path===f.backupRoots[0]&&item.reason==='runtime-in-use'));
 await lease.release();assert.deepEqual((await f.run()).removed,[f.backupRoots[0]]);
});
test('Existing installer publication locks are preserved without takeover or deletion',async t=>{
 const f=await fixture(t);await f.backups();const lock=f.installRoot+'.install-lock';await fs.mkdir(lock);await fs.writeFile(path.join(lock,'owner.pid'),'existing installer owner');
 const result=await f.run();assert.deepEqual(result.removed,[]);assert.ok(result.kept.some(item=>item.reason==='installation-in-progress'));
 assert.equal(await fs.readFile(path.join(lock,'owner.pid'),'utf8'),'existing installer owner');
 await fs.unlink(path.join(lock,'owner.pid'));await fs.rmdir(lock);assert.deepEqual((await f.run()).removed,[f.backupRoots[0]]);
});
test('Cleanup releases only its own installer lock after denied authorization and deletion errors',async t=>{
 const f=await fixture(t);await f.backups();const lock=f.installRoot+'.install-lock';
 await f.run({beforeDelete:async()=>{assert.equal((await fs.readFile(path.join(lock,'owner.pid'),'utf8')).trim(),String(process.pid));throw Error('fixture revoke');}});
 await assert.rejects(fs.access(lock),{code:'ENOENT'});
 const rm=fs.rm.bind(fs),mocked=t.mock.method(fs,'rm',async(filename,options)=>{if(filename===f.backupRoots[0])throw Error('fixture deletion error');return rm(filename,options);});
 await f.run();mocked.mock.restore();await assert.rejects(fs.access(lock),{code:'ENOENT'});
 assert.deepEqual((await f.run()).removed,[f.backupRoots[0]]);
});
test('Every reserved managed-backup name fails closed after partial marker removal; ordinary staging remains usable',async t=>{
 const f=await fixture(t);await f.backups();
 for(const root of f.backupRoots){
  await fs.unlink(path.join(root,OWNER_FILE));await fs.unlink(path.join(root,CAPABILITY_FILE));let main=false;
  await assert.rejects(acquireForEntrypoint(pathToFileURL(path.join(root,'dist/index.js'))).then(()=>{main=true;}));assert.equal(main,false);
 }
 const staging=path.join(f.root,'.neurocenter-dev-install-Stage1','new');await fs.mkdir(path.join(staging,'dist'),{recursive:true});
 assert.equal(await acquireForEntrypoint(pathToFileURL(path.join(staging,'dist/index.js'))),undefined);
});
test('A directory swap during fresh authorization cannot delete the replacement at the candidate path',async t=>{
 const f=await fixture(t);await f.backups();let called=0;
 const result=await f.run({beforeDelete:async()=>{if(++called===2){await fs.rename(f.backupRoots[0],path.join(f.root,'preserved-original'));await runtime(f.backupRoots[0],f.installRoot,'new replacement',{baseline:false});}}});
 assert.deepEqual(result.removed,[]);assert.ok(result.warnings.length);
 assert.equal(await fs.readFile(path.join(f.backupRoots[0],'dist/index.js'),'utf8'),'new replacement');
 assert.equal(await fs.readFile(path.join(f.installRoot,'dist/index.js'),'utf8'),'current');
});
for(const mutation of ['edit','new-file'])test('Verified prepublish baseline prevents adopting '+mutation+' changes before the success receipt',async t=>{
 const f=await fixture(t),backupRoot=f.backupRoots[0];await runtime(backupRoot,f.installRoot);
 if(mutation==='edit')await fs.appendFile(path.join(backupRoot,'dist/index.js'),'manual edit before receipt');
 else await fs.writeFile(path.join(backupRoot,'manual.txt'),'new manual file before receipt');
 assert.deepEqual(await writeSuccessfulBackupReceipt({installRoot:f.installRoot,backupRoot,completedAt:NOW-20*DAY}),{eligible:false,reason:'changed-installed-runtime'});
 await assert.rejects(writeInstalledRuntimeReceipt({installRoot:f.installRoot,runtimeRoot:backupRoot}));
 await assert.rejects(writeInstalledRuntimeReceipt({installRoot:f.installRoot,runtimeRoot:f.installRoot}));
 assert.deepEqual((await f.run()).removed,[]);await fs.access(backupRoot);
});
test('A lease-aware runtime without a verified installed baseline remains ineligible',async t=>{
 const f=await fixture(t),backupRoot=f.backupRoots[0];await runtime(backupRoot,f.installRoot,'no verified baseline',{baseline:false});
 assert.deepEqual(await writeSuccessfulBackupReceipt({installRoot:f.installRoot,backupRoot}),{eligible:false,reason:'missing-installed-baseline'});
 assert.deepEqual((await f.run()).removed,[]);assert.equal(await fs.readFile(path.join(backupRoot,'dist/index.js'),'utf8'),'no verified baseline');
});
test('A prepublish baseline is immutable even when its same staged inode is edited afterwards',async t=>{
 const f=await fixture(t),stage=path.join(f.root,'unpublished-stage');await runtime(stage,f.installRoot);
 await fs.appendFile(path.join(stage,'bin/node'),'manual stage mutation');
 await assert.rejects(writeInstalledRuntimeReceipt({installRoot:f.installRoot,runtimeRoot:stage}),/cannot adopt changed bytes/);
});
test('An existing dead-PID cleanup lock is never unlinked or taken over',async t=>{
 const f=await fixture(t);await f.backups();const root=await controlRootForInstallRoot(f.installRoot),filename=path.join(root,'lock.json');
 const bytes=JSON.stringify({schemaVersion:1,pid:2147483646,token:'owned-stale-fixture'});await fs.writeFile(filename,bytes);
 const kill=process.kill.bind(process);t.mock.method(process,'kill',(pid,signal)=>{if(pid===2147483646)throw Object.assign(Error('fixture dead'),{code:'ESRCH'});return kill(pid,signal);});
 const result=await f.run();assert.deepEqual(result.removed,[]);assert.ok(result.warnings.length);assert.equal(await fs.readFile(filename,'utf8'),bytes);
 await fs.unlink(filename);assert.deepEqual((await f.run()).removed,[f.backupRoots[0]]);
});
