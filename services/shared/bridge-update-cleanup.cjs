'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const {fileURLToPath}=require('node:url');
const {createHash,randomUUID}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {withInstallMutex,recoverCleanupLock}=require('./bridge-update-lock.cjs');

const OWNER_FILE='.neurocenter-update-owner.json';
const CAPABILITY_FILE='dist/runtime-use.json';
const RUNTIME_USE_ENTRYPOINTS=Object.freeze(['dist/index.js','dist/bridge-cli.js','dist/features/local-configuration/launcher-cli.js',
 'dist/features/opencode-providers/ollama-sdk.js','dist/bridge/connect.js','dist/features/opencode-providers/authorization.js']);
const DEFAULT_CLEANUP_POLICY=Object.freeze({enabled:true,keepPrevious:0,minAgeDays:0});
const MAX_ENTRIES=50000,MAX_BYTES=2*1024**3,MAX_RECEIPT_BYTES=16*1024**2,MAX_RECEIPTS=256;
const digest=value=>createHash('sha256').update(value).digest('hex');
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const identity=stat=>({dev:String(stat.dev),ino:String(stat.ino)});
const sameIdentity=(left,right)=>left.dev===right.dev&&left.ino===right.ino;
const validIdentity=value=>exact(value,['dev','ino'])&&/^\d+$/.test(value.dev)&&/^\d+$/.test(value.ino);
const stamp=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.nlink,stat.mode].map(String).join(':');
const missing=error=>error?.code==='ENOENT';
const exists=filename=>fs.lstat(filename).then(()=>true,error=>{if(missing(error))return false;throw error;});
const cancelled=(error,signal)=>signal?.aborted&&(error===signal.reason||error?.name==='AbortError'&&error.cause===signal.reason);

/** Only the documented retention fields can change automatic cleanup. */
function normalizeCleanupPolicy(value=DEFAULT_CLEANUP_POLICY){
 if(!exact(value,['enabled','keepPrevious','minAgeDays'])||typeof value.enabled!=='boolean'
  ||!Number.isInteger(value.keepPrevious)||value.keepPrevious<0||value.keepPrevious>10
  ||!Number.isInteger(value.minAgeDays)||value.minAgeDays<0||value.minAgeDays>90)throw Error('Invalid bridge cleanup policy.');
 return {...value};
}
async function directoryIdentity(filename){
 const stat=await fs.lstat(filename,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe bridge directory.');
 return identity(stat);
}
async function installInfo(input){
 if(typeof input!=='string'||!path.isAbsolute(input))throw Error('Bridge install root must be absolute.');
 const parent=await fs.realpath(path.dirname(input)),parentIdentity=await directoryIdentity(parent);
 let root=path.join(parent,path.basename(input));
 if(await exists(root)){await directoryIdentity(root);root=await fs.realpath(root);if(path.dirname(root)!==parent)throw Error('Bridge install parent changed.');}
 return {root,parent,parentIdentity};
}
/** The control directory is outside replaceable runtimes and is stable across their renames. */
async function controlRootForInstallRoot(installRoot){
 const info=await installInfo(installRoot);return path.join(info.parent,'.neurocenter-update-'+digest(path.basename(info.root)).slice(0,24));
}
async function privateDirectory(filename){
 try{await fs.mkdir(filename,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 const stat=await fs.lstat(filename);if(!stat.isDirectory()||stat.isSymbolicLink()||process.platform!=='win32'&&(stat.mode&0o077))throw Error('Bridge cleanup control directory is not private.');
}
async function control(info){
 const root=await controlRootForInstallRoot(info.root);await privateDirectory(root);
 for(const name of ['leases','receipts','baselines','locks'])await privateDirectory(path.join(root,name));return root;
}
async function syncDirectory(filename){
 if(process.platform==='win32')return;
 const handle=await fs.open(filename,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try{await handle.sync();}finally{await handle.close();}
}
async function readRegular(filename,maximum,signal){
 signal?.throwIfAborted();
 const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  signal?.throwIfAborted();
  const before=await handle.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size>BigInt(maximum))throw Error('Unsafe bridge cleanup metadata.');
  const chunks=[];let size=0;
  for await(const chunk of handle.createReadStream({autoClose:false,signal})){signal?.throwIfAborted();size+=chunk.length;if(size>maximum)throw Error('Bridge cleanup metadata exceeds its limit.');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks),after=await handle.stat({bigint:true}),named=await fs.lstat(filename,{bigint:true});
  if(stamp(before)!==stamp(after)||stamp(after)!==stamp(named)||named.isSymbolicLink())throw Error('Bridge cleanup metadata changed.');
  return {bytes,identity:identity(before)};
 }finally{await handle.close();}
}
async function readJson(filename,maximum=16384,signal){return JSON.parse((await readRegular(filename,maximum,signal)).bytes.toString('utf8'));}
function pidState(pid){
 if(!Number.isSafeInteger(pid)||pid<1)return 'unknown';
 try{process.kill(pid,0);return 'live';}catch(error){return error.code==='ESRCH'?'dead':'unknown';}
}
/** Explicit installers may quarantine a pinned dead owner; automatic cleanup never takes a lock over. */
async function locked(root,action,runtimeIdentity,installer,signal){
 const filename=runtimeIdentity?gcGate(root,runtimeIdentity):path.join(root,'lock.json');
 const token=randomUUID(),bytes=Buffer.from(JSON.stringify({schemaVersion:1,pid:process.pid,token}));
 let claimed=false,recoveryAttempted=false;
 for(let attempt=0;attempt<40;attempt++){
  signal?.throwIfAborted();
  try{
   const handle=await fs.open(filename,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();claimed=true;}finally{await handle.close();}break;
  }catch(error){
   if(error.code!=='EEXIST')throw error;
   if(installer&&!runtimeIdentity&&!recoveryAttempted){
    recoveryAttempted=true;if(await recoverCleanupLock({root,filename,...installer}))continue;
   }
   if(attempt===39)throw Error('Bridge runtime cleanup is busy.');
   await delay(25,undefined,{signal});
  }
 }
 if(!claimed)throw Error('Could not lock bridge cleanup.');
 try{signal?.throwIfAborted();await installer?.proof.assertCurrent();return await action();}finally{
  const current=await readRegular(filename,1024);if(!current.bytes.equals(bytes))throw Error('Bridge cleanup lock ownership changed.');await fs.unlink(filename);
 }
}
async function managedRuntime(runtimeRoot,required=false,signal){
 signal?.throwIfAborted();
 const stat=await fs.lstat(runtimeRoot,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe bridge runtime root.');
 const root=await fs.realpath(runtimeRoot),ownerFile=path.join(root,OWNER_FILE);
 if(!await exists(ownerFile)){if(required||reservedBackupName(path.basename(root)))throw Error('Managed bridge owner is missing.');return undefined;}
 const owner=await readJson(ownerFile,16384,signal),capability=await readJson(path.join(root,CAPABILITY_FILE),16384,signal);
 if(!exact(owner,['schemaVersion','installRoot'])||owner.schemaVersion!==1||typeof owner.installRoot!=='string')throw Error('Invalid managed bridge owner.');
 if(!exact(capability,['schemaVersion','entrypoints'])||capability.schemaVersion!==1||!Array.isArray(capability.entrypoints)
  ||JSON.stringify([...capability.entrypoints].sort())!==JSON.stringify([...RUNTIME_USE_ENTRYPOINTS].sort()))throw Error('Bridge runtime is not lease-aware.');
 const install=await installInfo(owner.installRoot);if(install.root!==owner.installRoot)throw Error('Managed install identity is not canonical.');
 if(!sameIdentity(identity(stat),await directoryIdentity(root)))throw Error('Bridge runtime identity changed.');
 return {root,identity:identity(stat),install,owner,capability};
}
function leaseKey(value){return value.dev+'-'+value.ino;}
function gcGate(root,value){return path.join(root,'locks','gc-runtime-'+leaseKey(value)+'.json');}
/** Acquire before importing runtime modules. Its inode key continues to protect a renamed backup. */
async function acquireRuntimeUseLease(runtimeRoot,{required=false}={}){
 const observed=await managedRuntime(runtimeRoot,required);if(!observed)return undefined;
 const root=await control(observed.install),directory=path.join(root,'leases',leaseKey(observed.identity));await privateDirectory(directory);
 const token=randomUUID(),filename=path.join(directory,token+'.json'),record={schemaVersion:1,runtime:observed.identity,pid:process.pid,token},bytes=Buffer.from(JSON.stringify(record));
 let owned,persisted=false,releasing;
 const release=()=>releasing??=(async()=>{
  const stored=await readRegular(filename,1024);
  if(!sameIdentity(stored.identity,owned)||persisted&&!stored.bytes.equals(bytes))throw Error('Runtime lease ownership changed.');
  await fs.unlink(filename);await syncDirectory(directory);
 })();
 try{
  const handle=await fs.open(filename,'wx',0o600);
  try{owned=identity(await handle.stat({bigint:true}));await handle.writeFile(bytes);await handle.sync();persisted=true;}finally{await handle.close();}
  await syncDirectory(directory);
  // GC claims its gate before scanning leases. A reader publishes its lease before observing the gate.
  const isCurrent=observed.root===observed.install.root;
  if(!isCurrent&&await exists(gcGate(root,observed.identity)))throw Error('Bridge backup cleanup is in progress.');
  const current=await managedRuntime(runtimeRoot,true);
  if(!sameIdentity(observed.identity,current.identity)||JSON.stringify(observed.owner)!==JSON.stringify(current.owner))throw Error('Bridge runtime changed before registration.');
  if(!isCurrent&&await exists(gcGate(root,observed.identity)))throw Error('Bridge backup cleanup began during registration.');
  const final=await managedRuntime(runtimeRoot,true);
  if(!sameIdentity(observed.identity,final.identity)||JSON.stringify(observed.owner)!==JSON.stringify(final.owner))throw Error('Bridge runtime changed after registration.');
  return {identity:observed.identity,release};
 }catch(error){if(owned)try{await release();}catch{/* Preserve ambiguous lease metadata rather than unlink another owner. */}throw error;}
}
/** Bootstrap convenience: staging without an owner is unregistered; managed entrypoints fail closed. */
async function acquireForEntrypoint(input,{ascend,required=false}={}){
 const filename=input instanceof URL?fileURLToPath(input):typeof input==='string'&&input.startsWith('file:')?fileURLToPath(input):input;
 if(typeof filename!=='string'||!path.isAbsolute(filename)||ascend!==undefined&&(!Number.isInteger(ascend)||ascend<0||ascend>8))throw Error('Invalid bridge bootstrap entrypoint.');
 let root=path.dirname(filename);
 if(ascend!==undefined){for(let step=0;step<ascend;step++)root=path.dirname(root);}
 for(let step=0;step<=(ascend===undefined?6:0);step++,root=path.dirname(root)){
  if(!await exists(path.join(root,OWNER_FILE))){if(reservedBackupName(path.basename(root)))throw Error('Unmarked managed backup cannot execute.');continue;}
  const relative=path.relative(root,filename).split(path.sep).join('/');if(!RUNTIME_USE_ENTRYPOINTS.includes(relative))throw Error('Unknown managed bridge entrypoint.');
  return acquireRuntimeUseLease(root,{required:true});
 }
 if(required)throw Error('Managed bridge owner is missing.');return undefined;
}
function backupName(name,installName){
 const escaped=installName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return /^\.neurocenter-previous\.[A-Za-z0-9]{6}$/.test(name)
  ||/^\.neurocenter-previous-\.neurocenter-dev-install-[A-Za-z0-9]+$/.test(name)
  ||new RegExp('^'+escaped+'\\.previous-[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$').test(name);
}
function reservedBackupName(name){
 return /^\.neurocenter-previous[.-]/.test(name)||/^.+\.previous-[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(name);
}
async function backupPath(info,input){
 if(typeof input!=='string'||!path.isAbsolute(input)||path.dirname(input)!==info.parent||!backupName(path.basename(input),path.basename(info.root)))throw Error('Unowned bridge backup path.');
 if(input===info.root)throw Error('Current bridge runtime cannot be a backup.');
 return input;
}
/** A portable full-tree digest includes every regular byte, executable mode and empty directory. */
async function snapshotTree(root,signal){
 const entries=[],observed=[];let bytes=0;
 async function visit(filename,relative){
  signal?.throwIfAborted();
  const before=await fs.lstat(filename,{bigint:true});
  if(before.isSymbolicLink()||!before.isDirectory()&&(!before.isFile()||before.nlink!==1n))throw Error('Bridge backup contains a link or special file.');
  if(relative.length>1024||relative&&relative.split('/').some(part=>!part||part==='.'||part==='..'||/[\\\x00-\x1f\x7f]/.test(part)))throw Error('Bridge backup path is not portable.');
  if(entries.length>=MAX_ENTRIES)throw Error('Bridge backup inventory exceeds its entry limit.');
  const record={path:relative,type:before.isDirectory()?'directory':'file',mode:Number(before.mode&0o7777n)};
  if(before.isDirectory()){
   entries.push(record);for(const name of (await fs.readdir(filename)).sort())await visit(path.join(filename,name),relative?relative+'/'+name:name);
  }else{
   bytes+=Number(before.size);if(bytes>MAX_BYTES)throw Error('Bridge backup inventory exceeds its byte limit.');
   const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    if(stamp(await handle.stat({bigint:true}))!==stamp(before))throw Error('Bridge backup changed during inspection.');
    const hash=createHash('sha256');let read=0;
    for await(const chunk of handle.createReadStream({autoClose:false,signal})){signal?.throwIfAborted();read+=chunk.length;if(read>Number(before.size))throw Error('Bridge backup grew during inspection.');hash.update(chunk);}
    if(read!==Number(before.size)||stamp(await handle.stat({bigint:true}))!==stamp(before))throw Error('Bridge backup changed during inspection.');
    entries.push({...record,bytes:read,sha256:hash.digest('hex')});
   }finally{await handle.close();}
  }
  if(stamp(await fs.lstat(filename,{bigint:true}))!==stamp(before))throw Error('Bridge backup changed during inspection.');observed.push([filename,stamp(before)]);
 }
 const assertUnchanged=async()=>{for(const [filename,before] of observed){signal?.throwIfAborted();if(stamp(await fs.lstat(filename,{bigint:true}))!==before)throw Error('Bridge backup changed during inspection.');}};
 await visit(root,'');await assertUnchanged();
 return {entries,bytes,digest:digest(JSON.stringify(entries)),identity:await directoryIdentity(root),assertUnchanged};
}
async function saveReceipt(directory,filename,record,replace=false){
 const bytes=JSON.stringify(record);if(Buffer.byteLength(bytes)>MAX_RECEIPT_BYTES)throw Error('Bridge backup receipt exceeds its limit.');
 const temporary=path.join(directory,'.'+randomUUID()+'.partial');
 try{
  const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  if(!replace&&await exists(filename))throw Error('Bridge backup receipt already exists.');
  await fs.rename(temporary,filename);await syncDirectory(directory);
 }finally{await fs.rm(temporary,{force:true});}
}
const baselineFile=(root,value)=>path.join(root,'baselines','installed-'+digest(leaseKey(value))+'.json');
const sameInstall=(value,info)=>exact(value,['root','parent'])&&value.root===info.root&&validIdentity(value.parent)&&sameIdentity(value.parent,info.parentIdentity);
async function installedBaseline(root,info,value,signal){
 const filename=baselineFile(root,value);if(!await exists(filename))return undefined;
 const record=await readJson(filename,MAX_RECEIPT_BYTES,signal);
 if(!exact(record,['schemaVersion','install','runtime','tree'])||record.schemaVersion!==1||!sameInstall(record.install,info)
  ||!exact(record.runtime,['identity'])||!validIdentity(record.runtime.identity)||!sameIdentity(record.runtime.identity,value))throw Error('Invalid installed bridge baseline.');
 treeShape(record.tree);return record;
}
/** The installer records its verified stage before publish; existing mutable installs are never adopted. */
async function writeInstalledRuntimeReceipt({installRoot,runtimeRoot}){
 const info=await installInfo(installRoot),runtime=await managedRuntime(runtimeRoot,true);
 if(runtime.root===info.root||reservedBackupName(path.basename(runtime.root))||runtime.install.root!==info.root)throw Error('Only a verified unpublished bridge stage can receive a baseline.');
 return(await withInstallMutex(info,async proof=>{
 const root=await control(info);return locked(root,async()=>{
  const tree=await snapshotTree(runtime.root);if(!sameIdentity(tree.identity,runtime.identity))throw Error('Bridge stage identity changed.');
  const record={schemaVersion:1,install:{root:info.root,parent:info.parentIdentity},runtime:{identity:tree.identity},tree:{entries:tree.entries,bytes:tree.bytes,digest:tree.digest}};
  const existing=await installedBaseline(root,info,tree.identity),filename=baselineFile(root,tree.identity);
  if(existing){if(existing.tree.digest!==tree.digest)throw Error('Installed bridge baseline cannot adopt changed bytes.');}
  else await saveReceipt(path.join(root,'baselines'),filename,record);
  return {baselinePath:filename};
 },undefined,{info,proof});})).value;
}
/** Called only after the installer has verified successful replacement; legacy runtimes stay ineligible. */
async function writeSuccessfulBackupReceipt({installRoot,backupRoot,completedAt=Date.now()}){
 const info=await installInfo(installRoot);await backupPath(info,backupRoot);
 if(!Number.isSafeInteger(completedAt)||completedAt<0)throw Error('Invalid bridge backup completion time.');
 if(!await exists(path.join(backupRoot,OWNER_FILE))||!await exists(path.join(backupRoot,CAPABILITY_FILE)))return {eligible:false,reason:'legacy-runtime'};
 return(await withInstallMutex(info,async proof=>{
 const root=await control(info);return locked(root,async()=>{
  const current=await managedRuntime(info.root,true),backup=await managedRuntime(backupRoot,true);
  if(current.install.root!==info.root||backup.install.root!==info.root||sameIdentity(current.identity,backup.identity))throw Error('Bridge backup owner does not match its installation.');
  const tree=await snapshotTree(backupRoot),baseline=await installedBaseline(root,info,tree.identity);
  if(!baseline)return {eligible:false,reason:'missing-installed-baseline'};
  if(baseline.tree.digest!==tree.digest)return {eligible:false,reason:'changed-installed-runtime'};
  const directory=path.join(root,'receipts'),filename=path.join(directory,'backup-'+digest(path.basename(backupRoot)+'\0'+leaseKey(tree.identity))+'.json');
  const record={schemaVersion:1,install:{root:info.root,parent:info.parentIdentity},backup:{root:backupRoot,identity:tree.identity},completedAt,state:'complete',tree:{entries:tree.entries,bytes:tree.bytes,digest:tree.digest}};
  if(await exists(filename)){
   const existing=await readJson(filename,MAX_RECEIPT_BYTES);if(existing.state!=='complete'||existing.tree?.digest!==tree.digest||!sameIdentity(existing.backup?.identity??{},tree.identity))throw Error('Existing bridge backup receipt is ambiguous.');
  }else await saveReceipt(directory,filename,record);
  return {eligible:true,receiptPath:filename};
 },undefined,{info,proof});})).value;
}
function treeShape(tree){
 if(!exact(tree,['entries','bytes','digest'])||!Array.isArray(tree.entries)||tree.entries.length<1||tree.entries.length>MAX_ENTRIES
  ||!Number.isSafeInteger(tree.bytes)||tree.bytes<0||tree.bytes>MAX_BYTES||tree.digest!==digest(JSON.stringify(tree.entries)))throw Error('Invalid bridge backup inventory.');
 const seen=new Set();let bytes=0;
 for(const entry of tree.entries){
  if(!entry||typeof entry.path!=='string'||seen.has(entry.path)||!Number.isInteger(entry.mode)||entry.mode<0||entry.mode>0o7777)throw Error('Invalid bridge backup inventory.');
  seen.add(entry.path);if(entry.type==='file'){
   if(!exact(entry,['path','type','mode','bytes','sha256'])||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid bridge backup inventory.');bytes+=entry.bytes;
  }else if(entry.type!=='directory'||!exact(entry,['path','type','mode']))throw Error('Invalid bridge backup inventory.');
 }
 if(bytes!==tree.bytes||tree.entries[0].path!==''||tree.entries[0].type!=='directory')throw Error('Invalid bridge backup inventory.');
}
function receiptShape(record,info){
 if(!exact(record,['schemaVersion','install','backup','completedAt','state','tree'])||record.schemaVersion!==1
  ||!sameInstall(record.install,info)
  ||!exact(record.backup,['root','identity'])||!validIdentity(record.backup.identity)||!Number.isSafeInteger(record.completedAt)||record.completedAt<0
  ||!['complete','deleting'].includes(record.state))throw Error('Invalid bridge backup receipt.');
 treeShape(record.tree);
}
async function busyLease(root,value,signal){
 signal?.throwIfAborted();
 const directory=path.join(root,'leases',leaseKey(value));if(!await exists(directory))return false;
 await directoryIdentity(directory);const names=await fs.readdir(directory);if(names.length>MAX_ENTRIES)return true;
 for(const name of names){
  signal?.throwIfAborted();
  if(!/^[a-f0-9-]{36}\.json$/.test(name))return true;
  try{
   const record=await readJson(path.join(directory,name),1024,signal);
   if(!exact(record,['schemaVersion','runtime','pid','token'])||record.schemaVersion!==1||!validIdentity(record.runtime)||!sameIdentity(record.runtime,value)
    ||record.token+'.json'!==name||pidState(record.pid)!=='dead')return true;
  }catch(error){if(cancelled(error,signal))throw signal.reason;return true;}
 }
 return false;
}
/** A live foreign consumer may have crossed a publish boundary; keep the entire installation lineage. */
async function busyLineage(root,current,signal){
 try{
  signal?.throwIfAborted();
  const directory=path.join(root,'leases'),names=await fs.readdir(directory);if(names.length>MAX_ENTRIES)return true;
  for(const name of names){
   signal?.throwIfAborted();
   if(!/^\d+-\d+$/.test(name))return true;
   const leases=path.join(directory,name);await directoryIdentity(leases);const files=await fs.readdir(leases);if(files.length>MAX_ENTRIES)return true;
   for(const file of files){
    signal?.throwIfAborted();
    if(!/^[a-f0-9-]{36}\.json$/.test(file))return true;
    const record=await readJson(path.join(leases,file),1024,signal);
    if(!exact(record,['schemaVersion','runtime','pid','token'])||record.schemaVersion!==1||!validIdentity(record.runtime)
     ||leaseKey(record.runtime)!==name||record.token+'.json'!==file)return true;
    if(record.pid===process.pid&&sameIdentity(record.runtime,current))continue;
    if(pidState(record.pid)!=='dead')return true;
   }
  }
  return false;
 }catch(error){if(cancelled(error,signal))throw signal.reason;return true;}
}
function unchangedRemainder(tree,original){
 const records=new Map(original.entries.map(entry=>[entry.path,JSON.stringify(entry)]));
 return tree.entries.every(entry=>records.get(entry.path)===JSON.stringify(entry));
}
/** Read-only maintenance may cancel; admitted deletion and ownership finalizers always finish. */
async function cleanupSuccessfulBackups({installRoot,policy=DEFAULT_CLEANUP_POLICY,now=Date.now(),beforeDelete,signal}){
 const result={removed:[],kept:[],warnings:[]};
 try{
  signal?.throwIfAborted();
  policy=normalizeCleanupPolicy(policy);if(!policy.enabled)return result;if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid bridge cleanup time.');
  const info=await installInfo(installRoot);
  const acquired=await withInstallMutex(info,async()=>{
  const root=await control(info);await locked(root,async()=>{
   const current=await managedRuntime(info.root,true,signal),directory=path.join(root,'receipts'),names=await fs.readdir(directory),valid=[];
   if(names.length>MAX_RECEIPTS)throw Error('Bridge cleanup receipt limit exceeded.');
   for(const name of names){
    signal?.throwIfAborted();
    if(!/^backup-[a-f0-9]{64}\.json$/.test(name)){result.warnings.push('Unrecognized bridge cleanup metadata preserved.');continue;}
    const filename=path.join(directory,name);let record;
    try{
     record=await readJson(filename,MAX_RECEIPT_BYTES,signal);receiptShape(record,info);await backupPath(info,record.backup.root);
     const baseline=await installedBaseline(root,info,record.backup.identity,signal);
     if(!baseline||baseline.tree.digest!==record.tree.digest)throw Error('Bridge backup has no matching installed baseline.');
     if(!await exists(record.backup.root)){result.kept.push({path:record.backup.root,reason:'missing-backup'});continue;}
     const observed=record.state==='complete'?await managedRuntime(record.backup.root,true,signal):{identity:await directoryIdentity(record.backup.root),install:info};
     if(!sameIdentity(observed.identity,record.backup.identity)||sameIdentity(observed.identity,current.identity)||observed.install.root!==info.root)throw Error('Bridge backup identity changed.');
     const tree=await snapshotTree(record.backup.root,signal);
     if(record.state==='complete'?tree.digest!==record.tree.digest:!unchangedRemainder(tree,record.tree))throw Error('Bridge backup was manually changed.');
     valid.push({record,filename});
    }catch(error){
     if(cancelled(error,signal)){if(!result.warnings.length)throw signal.reason;return;}
     result.kept.push({path:record?.backup?.root??filename,reason:'unverified-backup'});result.warnings.push('Unverified bridge backup preserved.');
    }
   }
   const identities=new Set(),ambiguous=new Set();for(const item of valid){const key=leaseKey(item.record.backup.identity);if(identities.has(key))ambiguous.add(key);identities.add(key);}
   const complete=valid.filter(item=>item.record.state==='complete'&&!ambiguous.has(leaseKey(item.record.backup.identity))).sort((a,b)=>b.record.completedAt-a.record.completedAt||a.record.backup.root.localeCompare(b.record.backup.root));
   const retained=new Set(complete.slice(0,policy.keepPrevious).map(item=>item.filename));
   for(const {record,filename} of valid){
    signal?.throwIfAborted();
    const backup=record.backup.root;let reason;
    if(ambiguous.has(leaseKey(record.backup.identity)))reason='ambiguous-receipts';
    else if(retained.has(filename))reason='retained-rollback';
    else if(now-record.completedAt<policy.minAgeDays*86400000)reason='too-recent';
    if(reason){result.kept.push({path:backup,reason});continue;}
    try{
     await locked(root,async()=>{
     if(await busyLease(root,record.backup.identity,signal)||await busyLineage(root,current.identity,signal)){result.kept.push({path:backup,reason:'runtime-in-use'});return;}
     if(!sameIdentity(await directoryIdentity(backup),record.backup.identity)||!sameIdentity(await directoryIdentity(info.root),current.identity))throw Error('Bridge runtime identity changed before cleanup.');
     const tree=await snapshotTree(backup,signal);if(record.state==='complete'?tree.digest!==record.tree.digest:!unchangedRemainder(tree,record.tree))throw Error('Bridge backup changed before cleanup.');
     signal?.throwIfAborted();
     await beforeDelete?.();
     signal?.throwIfAborted();
     if(record.state==='complete'){record.state='deleting';await saveReceipt(directory,filename,record,true);}
     signal?.throwIfAborted();
     await beforeDelete?.();
     signal?.throwIfAborted();
     await tree.assertUnchanged();const fresh=await managedRuntime(info.root,true,signal);
     if(!sameIdentity(fresh.identity,current.identity)||!sameIdentity(await directoryIdentity(info.parent),info.parentIdentity)
      ||await busyLease(root,record.backup.identity,signal)||await busyLineage(root,current.identity,signal))throw Error('Bridge cleanup boundary changed.');
     signal?.throwIfAborted();
     // Once removal starts, finish its receipt and directory durability boundary without cancellation.
     await fs.rm(backup,{recursive:true,force:false});await syncDirectory(info.parent);await fs.unlink(filename);await syncDirectory(directory);result.removed.push(backup);
     },record.backup.identity,undefined,signal);
    }catch(error){
     if(cancelled(error,signal)){if(!result.warnings.length)throw signal.reason;return;}
     result.kept.push({path:backup,reason:'cleanup-incomplete'});result.warnings.push('Bridge backup cleanup incomplete; its recovery tombstone was preserved.');
    }
   }
  },undefined,undefined,signal);
  },{reuse:false});
  if(!acquired.acquired)result.kept.push({path:info.root,reason:'installation-in-progress'});
 }catch(error){
  if(cancelled(error,signal)){if(!result.warnings.length)throw signal.reason;}
  else result.warnings.push('Bridge backup cleanup was skipped safely.');
 }
 return result;
}
module.exports={OWNER_FILE,CAPABILITY_FILE,RUNTIME_USE_ENTRYPOINTS,DEFAULT_CLEANUP_POLICY,normalizeCleanupPolicy,controlRootForInstallRoot,
 acquireRuntimeUseLease,acquireForEntrypoint,writeInstalledRuntimeReceipt,writeSuccessfulBackupReceipt,cleanupSuccessfulBackups};
