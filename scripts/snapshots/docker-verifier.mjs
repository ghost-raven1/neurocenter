import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

function command(args,{signal,maximum=256*1024,timeout=15000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn('docker',args,{stdio:['ignore','pipe','pipe'],signal,timeout});const output=[],errors=[];let bytes=0,failed;
  const collect=target=>value=>{bytes+=value.length;if(bytes>maximum){failed=new Error('RESOURCE_LIMIT');child.kill('SIGKILL');}else target.push(value);};
  child.stdout.on('data',collect(output));child.stderr.on('data',collect(errors));child.once('error',error=>{failed=error;});
  child.once('close',(code,killed)=>{if(failed)return reject(failed);if(code!==0)return reject(new Error(errors.length&&/FILES_CHANGED/.test(Buffer.concat(errors).toString())?'FILES_CHANGED':killed?'RESOURCE_LIMIT':'LANCE_READ_FAILED'));resolve(Buffer.concat(output).toString('utf8'));});
 });
}
export async function snapshotVerifierImage(image){
 if(typeof image!=='string'||image.length>256||!/^[-a-zA-Z0-9_./:@]+$/.test(image))throw new Error('UNSAFE_VERIFIER_IMAGE');
 const id=(await command(['image','inspect',image,'--format','{{.Id}}'])).trim();if(!/^sha256:[a-f0-9]{64}$/.test(id))throw new Error('UNSAFE_VERIFIER_IMAGE');return id;
}
/** No network, writable root, host config, project root, or Docker socket enters the verifier. */
export async function runSnapshotVerifier(stage,imageId,{signal,timeout=15*60*1000}={}){
 if(!/^sha256:[a-f0-9]{64}$/.test(imageId))throw new Error('UNSAFE_VERIFIER_IMAGE');
 const cid=path.join(stage,'verifier-'+randomUUID()+'.cid'),controller=new AbortController();
 const abort=()=>controller.abort(signal?.reason??new Error('RESOURCE_LIMIT'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(()=>controller.abort(new Error('RESOURCE_LIMIT')),timeout);timer.unref();
 try{
  const output=await command(['run','--rm','--cidfile',cid,'--network','none','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','2g','--cpus','2','--mount',`type=bind,src=${stage},dst=/snapshot,readonly`,imageId],{signal:controller.signal,timeout:timeout+15000});
  return JSON.parse(output);
 }catch(error){if(controller.signal.aborted)throw controller.signal.reason instanceof Error?controller.signal.reason:new Error('RESOURCE_LIMIT');throw error;
 }finally{
  clearTimeout(timer);signal?.removeEventListener('abort',abort);
  let id;try{id=(await fs.readFile(cid,'utf8')).trim();}catch(error){if(error.code!=='ENOENT')throw error;}
  if(id){if(!/^[a-f0-9]{64}$/.test(id))throw new Error('UNSAFE_VERIFIER_CONTAINER');await command(['rm','-f',id]).catch(()=>undefined);}
  await fs.rm(cid,{force:true});
 }
}
