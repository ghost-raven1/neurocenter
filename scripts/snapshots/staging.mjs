import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import contract from '../../services/shared/project-snapshot.cjs';
const format='neurocenter.snapshot-stage/v1',ownerFile='.snapshot-owner.json',reserve=256*1024**2;
const uid=()=>process.getuid?.()??null;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const stageName=value=>/^snapshot-[a-zA-Z0-9]{6}$/.test(value);
async function privateRoot(directory){
 const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077||uid()!==null&&stat.uid!==uid())throw new Error('UNSAFE_RUNNER_DIRECTORY');
}
async function syncDirectory(directory){const file=await fs.open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await file.sync();}finally{await file.close();}}
async function marker(directory,name){
 if(!stageName(name))return;
 const filename=path.join(directory,name);let file;
 try{
  const info=await fs.lstat(filename);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o022||uid()!==null&&info.uid!==uid())return;
  file=await fs.open(path.join(filename,ownerFile),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=await file.stat();if(!before.isFile()||before.nlink!==1||before.mode&0o077||before.size>4096||uid()!==null&&before.uid!==uid())return;
  const bytes=await file.readFile(),after=await file.stat();if(before.size!==bytes.length||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)return;
  const value=JSON.parse(bytes.toString('utf8'));
  if(!value||Object.keys(value).sort().join(',')!=='createdAt,format,host,pid,reservedBytes,runnerNonce,stage,uid'||value.format!==format||value.stage!==name||value.host!==hostname()||value.uid!==uid()
   ||!Number.isSafeInteger(value.pid)||value.pid<1||!uuid(value.runnerNonce)||!Number.isSafeInteger(value.reservedBytes)||value.reservedBytes<4096
   ||typeof value.createdAt!=='string'||new Date(value.createdAt).toISOString()!==value.createdAt)return;
  return {value,info};
 }catch(error){if(['ENOENT','ENOTDIR','ELOOP'].includes(error.code)||error instanceof SyntaxError||error instanceof RangeError)return;throw error;}
 finally{await file?.close();}
}
function definitelyDead(pid){try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}}
async function removeOwned(directory,name,expected){
 const checked=await marker(directory,name);
 if(!checked){try{await fs.lstat(path.join(directory,name));}catch(error){if(error.code==='ENOENT')return false;throw error;}throw new Error('UNSAFE_SNAPSHOT_STAGE');}
 if(JSON.stringify(checked.value)!==JSON.stringify(expected.value)||checked.info.ino!==expected.info.ino||checked.info.dev!==expected.info.dev)throw new Error('UNSAFE_SNAPSHOT_STAGE');
 await fs.rm(path.join(directory,name),{recursive:true,force:true});await syncDirectory(directory);return true;
}
/** PID reuse or denied process inspection conservatively keeps the stage. Unknown files are never adopted or removed. */
export async function sweepSnapshotStages(directory,{signal}={}){
 await privateRoot(directory);let removed=0,retained=0,unknown=0;
 const entries=await fs.readdir(directory);if(entries.length>256)throw new Error('RESOURCE_LIMIT');
 for(const name of entries){
  signal?.throwIfAborted();const saved=await marker(directory,name);
  if(!saved){unknown++;continue;}
  if(!definitelyDead(saved.value.pid)){retained++;continue;}
  try{if(await removeOwned(directory,name,saved))removed++;}catch(error){if(error.code==='ENOENT')continue;throw error;}
 }
 return {removed,retained,unknown};
}
/** Publish the reservation before admission: a competing admission sees it or conservatively refuses an incomplete marker. */
export async function reserveSnapshotStage(directory,claim,{runnerNonce=randomUUID(),signal}={}){
 signal?.throwIfAborted();await privateRoot(directory);
 const manifest=contract.normalizeSnapshotManifest(claim.manifest);
 if(contract.snapshotManifestHash(manifest)!==claim.manifestSha256||!uuid(runnerNonce))throw new Error('FILES_CHANGED');
 const bytes=manifest.files.reduce((sum,file)=>sum+file.size,0),maximum=Number(process.env.SNAPSHOT_MAX_BYTES||16*1024**3);
 const disk=await fs.statfs(directory,{bigint:true}),block=Number(disk.bsize);if(!Number.isSafeInteger(block)||block<1)throw new Error('RESOURCE_LIMIT');
 // Include conservative inode/directory allocation, even for many empty files sharing folders.
 const rounded=size=>Math.ceil(size/block)*block;
 const required=manifest.files.reduce((sum,file)=>sum+rounded(file.size)+(file.path.split('/').length+1)*block,0)+rounded(Buffer.byteLength(contract.snapshotCanonicalJson(manifest)))+3*block;
 const quota=Number(process.env.SNAPSHOT_STAGING_MAX_BYTES||32*1024**3);
 if(!Number.isSafeInteger(maximum)||maximum<1||bytes>maximum||!Number.isSafeInteger(required)||!Number.isSafeInteger(quota)||quota<1||required>quota)throw new Error('RESOURCE_LIMIT');
 signal?.throwIfAborted();const stage=await fs.mkdtemp(path.join(directory,'snapshot-')),name=path.basename(stage);
 const value={format,stage:name,pid:process.pid,host:hostname(),uid:uid(),runnerNonce,reservedBytes:required,createdAt:new Date().toISOString()};let owned;
 try{
  await fs.writeFile(path.join(stage,ownerFile),JSON.stringify(value)+'\n',{flag:'wx',mode:0o600,flush:true});await syncDirectory(stage);await syncDirectory(directory);owned=await marker(directory,name);
  if(!owned)throw new Error('UNSAFE_SNAPSHOT_STAGE');
  let total=0;const entries=await fs.readdir(directory);if(entries.length>256)throw new Error('RESOURCE_LIMIT');
  for(const entry of entries){signal?.throwIfAborted();const saved=await marker(directory,entry);if(!saved)throw new Error('RESOURCE_LIMIT');total+=saved.value.reservedBytes;if(!Number.isSafeInteger(total)||total>quota)throw new Error('RESOURCE_LIMIT');}
  const available=await fs.statfs(directory,{bigint:true});if(available.bavail*available.bsize<BigInt(total)+BigInt(reserve))throw new Error('RESOURCE_LIMIT');signal?.throwIfAborted();
  return {stage,reservedBytes:required,release:()=>removeOwned(directory,name,owned)};
 }catch(error){
  // This path was newly created by this invocation, before it became a payload destination.
  if(owned)await removeOwned(directory,name,owned);else await fs.rm(stage,{recursive:true,force:true});throw error;
 }
}
