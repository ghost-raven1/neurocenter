'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const identity=stat=>({dev:String(stat.dev),ino:String(stat.ino)});
const stamp=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.uid,stat.mode,stat.nlink].map(String).join(':');
const ownUid=stat=>typeof process.getuid!=='function'||Number(stat.uid)===process.getuid();
const dead=pid=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);

async function directory(filename,privateMode=false){
 const stat=await fs.lstat(filename,{bigint:true});
 if(!stat.isDirectory()||stat.isSymbolicLink()||!ownUid(stat)||privateMode&&process.platform!=='win32'&&(stat.mode&0o077n))throw Error('Unsafe bridge lock directory.');
 return identity(stat);
}
async function snapshot(filename,maximum=1024){
 const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await handle.stat({bigint:true});
  if(!before.isFile()||before.nlink!==1n||before.size>BigInt(maximum)||!ownUid(before)||process.platform!=='win32'&&(before.mode&0o077n))throw Error('Unsafe bridge lock file.');
  const bytes=await handle.readFile(),after=await handle.stat({bigint:true}),named=await fs.lstat(filename,{bigint:true});
  if(stamp(before)!==stamp(after)||stamp(after)!==stamp(named)||named.isSymbolicLink()||!ownUid(named))throw Error('Bridge lock changed during inspection.');
  return{filename,bytes,identity:identity(before),stamp:stamp(before)};
 }finally{await handle.close();}
}
async function unchanged(record){const current=await snapshot(record.filename);if(current.stamp!==record.stamp||!current.bytes.equals(record.bytes))throw Error('Bridge lock ownership changed.');}
async function owner(pid){
 if(!Number.isSafeInteger(pid)||pid<2)throw Error('Unknown bridge installer process.');
 if(process.platform==='win32'){
  const script=`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";if(-not $p){exit 1};$o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid;if($o.ReturnValue -ne 0){exit 1};@{parent=$p.ParentProcessId;owner=$o.Sid}|ConvertTo-Json -Compress`;
  const result=await execute('powershell.exe',['-NoProfile','-Command',script],{timeout:3000,maxBuffer:4096}),value=JSON.parse(result.stdout);
  if(typeof value.owner!=='string'||!value.owner||!Number.isSafeInteger(value.parent))throw Error('Unknown bridge installer owner.');
  return{pid,parent:value.parent,owner:value.owner};
 }
 if(pid===process.pid)return{pid,parent:process.ppid,owner:process.getuid()};
 if(process.platform==='linux'){
  const root='/proc/'+pid,[before,text]=await Promise.all([fs.stat(root),fs.readFile(root+'/stat','utf8')]),fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/),after=await fs.stat(root);
  if(before.uid!==after.uid||before.ino!==after.ino||!/^\d+$/.test(fields[1]??'')||!/^\d+$/.test(fields[19]??''))throw Error('Unknown bridge installer owner.');
  return{pid,parent:Number(fields[1]),owner:before.uid,started:fields[19]};
 }
 const result=await execute('/bin/ps',['-p',String(pid),'-o','uid=','-o','ppid='],{timeout:3000,maxBuffer:1024,env:{...process.env,LC_ALL:'C'}}),match=/^\s*(\d+)\s+(\d+)\s*$/.exec(result.stdout);
 if(!match)throw Error('Unknown bridge installer owner.');
 return{pid,parent:Number(match[2]),owner:Number(match[1])};
}
async function ancestor(pid){
 const self=await owner(process.pid);let current=self;
 for(let depth=0;depth<16;depth++){
  if(current.owner!==self.owner)break;
  if(current.pid===pid)return current;
  if(current.parent<2||current.parent===current.pid)break;
  current=await owner(current.parent);
 }
 throw Error('Installer publication lock is not owned by this process or its same-user ancestor.');
}
async function installerProof(info){
 const root=info.root+'.install-lock',observed=await directory(root,true),file=await snapshot(path.join(root,'owner.pid'),64),raw=file.bytes.toString('utf8').trim();
 if(!/^[1-9]\d*$/.test(raw))throw Error('Unknown bridge installer lock owner.');
 const pid=Number(raw),processOwner=await ancestor(pid);
 const assertCurrent=async()=>{
  if(!same(await directory(info.parent),info.parentIdentity)||!same(await directory(root,true),observed))throw Error('Installer publication directory changed.');
  await unchanged(file);if(JSON.stringify(await ancestor(pid))!==JSON.stringify(processOwner))throw Error('Installer process identity changed.');
 };
 await assertCurrent();return{root,pid,assertCurrent};
}

/** Explicit installer writers take the mutex or prove their caller owns the existing one. Maintenance never reuses it. */
async function withInstallMutex(info,action,{reuse=true}={}){
 const root=info.root+'.install-lock';let created=false;
 try{await fs.mkdir(root,{mode:0o700});created=true;}catch(error){if(error.code!=='EEXIST')throw error;}
 if(!created){if(!reuse)return{acquired:false};return{acquired:true,value:await action(await installerProof(info))};}
 const observed=await directory(root,true),filename=path.join(root,'owner.pid'),bytes=Buffer.from(String(process.pid)+'\n');let file,createdFile;
 try{
  const handle=await fs.open(filename,'wx',0o600);try{createdFile=identity(await handle.stat({bigint:true}));await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  file=await snapshot(filename,64);return{acquired:true,value:await action(await installerProof(info))};
 }finally{
  if(!same(await directory(root,true),observed))throw Error('Installer publication lock directory changed.');
  if(file){await unchanged(file);await fs.unlink(filename);}
  else if(createdFile){
   const partial=await snapshot(filename,64);
   if(!same(partial.identity,createdFile)||partial.bytes.length>bytes.length||!partial.bytes.equals(bytes.subarray(0,partial.bytes.length)))throw Error('Partial installer owner changed.');
   await fs.unlink(filename);
  }
  await fs.rmdir(root);
 }
}
async function syncDirectory(filename){if(process.platform==='win32')return;const handle=await fs.open(filename,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await handle.sync();}finally{await handle.close();}}

/** Restore a concurrently replaced owner only into a vacant original slot; never overwrite a newer claim. */
async function restoreUnexpected(quarantine,filename){
 const moved=await fs.lstat(quarantine,{bigint:true});
 try{await fs.link(quarantine,filename);}catch(error){if(error.code==='EEXIST')return;throw error;}
 const source=await fs.lstat(quarantine,{bigint:true}),restored=await fs.lstat(filename,{bigint:true});
 if(same(identity(moved),identity(source))&&same(identity(source),identity(restored))&&source.nlink===moved.nlink+1n)await fs.unlink(quarantine);
}

/** Legacy dead-owner records are quarantined only by a verified explicit installer. No lock is unlinked by PID. */
async function recoverCleanupLock({info,root,filename,proof}){
 if(!proof||typeof process.getuid!=='function')return false;
 await proof.assertCurrent();const control=await directory(root,true),record=await snapshot(filename),value=JSON.parse(record.bytes);
 if(!value||Object.keys(value).sort().join(',')!=='pid,schemaVersion,token'||value.schemaVersion!==1||!Number.isSafeInteger(value.pid)||value.pid<2||!uuid(value.token)||!dead(value.pid))return false;
 const quarantines=path.join(root,'quarantine');try{await fs.mkdir(quarantines,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 const destinationIdentity=await directory(quarantines,true),target=path.join(quarantines,'lock-'+value.token+'-'+randomUUID()+'.json');
 await proof.assertCurrent();await unchanged(record);
 if(!same(await directory(root,true),control)||!same(await directory(quarantines,true),destinationIdentity)||!dead(value.pid))throw Error('Bridge cleanup recovery authority changed.');
 await fs.rename(filename,target);
 let moved;
 try{moved=await snapshot(target);}catch(error){await restoreUnexpected(target,filename);throw Error('Bridge cleanup lock was replaced at the quarantine boundary.',{cause:error});}
 if(!same(moved.identity,record.identity)||!moved.bytes.equals(record.bytes)){
  await restoreUnexpected(target,filename);throw Error('Bridge cleanup lock was replaced at the quarantine boundary.');
 }
 if(!same(await directory(root,true),control)||!same(await directory(quarantines,true),destinationIdentity))throw Error('Bridge cleanup control directory changed after quarantine.');
 await proof.assertCurrent();
 const receipt={schemaVersion:1,action:'quarantined-dead-cleanup-owner',installRoot:info.root,ownerPid:value.pid,identity:record.identity,sha256:createHash('sha256').update(record.bytes).digest('hex'),quarantine:target};
 await fs.writeFile(target+'.receipt.json',JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600,flush:true});
 await syncDirectory(quarantines);await syncDirectory(root);return true;
}
module.exports={withInstallMutex,recoverCleanupLock};
