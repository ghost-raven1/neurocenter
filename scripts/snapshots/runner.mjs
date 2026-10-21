#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {privateSnapshotFile,snapshotControl} from './control.mjs';
import {materializeSnapshot} from './materialize.mjs';
import {snapshotVerifierImage,runSnapshotVerifier} from './docker-verifier.mjs';
import {reserveSnapshotStage,sweepSnapshotStages} from './staging.mjs';

/** Verification is readonly and leased; only the server can sign and publish the resulting receipt. */
export async function executeSnapshotVerification(claim,{api,workerId,imageId,directory,signal,verify=runSnapshotVerifier,timeout=15*60*1000}){
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>15*60*1000)throw new Error('RESOURCE_LIMIT');
 const controller=new AbortController();let reservation,timedOut=false;
 const abort=()=>controller.abort(signal?.reason??new Error('RUNNER_STOPPED'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const deadline=setTimeout(()=>{timedOut=true;controller.abort(new Error('RESOURCE_LIMIT'));},timeout);deadline.unref();
 let stopped=false;const pulseStop=new AbortController();
 const pulse=(async()=>{try{while(!stopped){await pause(30000,undefined,{signal:pulseStop.signal});if(!stopped)await api(`${claim.snapshotId}/renew`,{input:{workerId},signal:controller.signal});}}catch(error){if(!stopped)controller.abort(error);}})();
 try{
  reservation=await reserveSnapshotStage(directory,claim,{runnerNonce:workerId,signal:controller.signal});const {stage}=reservation;
  await materializeSnapshot(stage,claim,api,workerId,controller.signal);const result=await verify(stage,imageId,{signal:controller.signal});controller.signal.throwIfAborted();
  await api(`${claim.snapshotId}/complete`,{input:{workerId,result},signal:controller.signal});return {status:'VERIFIED',snapshotId:claim.snapshotId};
 }catch(error){
  if(!controller.signal.aborted||timedOut&&!signal?.aborted){const reason=timedOut?'RESOURCE_LIMIT':['FILES_CHANGED','LANCE_READ_FAILED','RESOURCE_LIMIT'].includes(error.message)?error.message:'STORAGE_UNAVAILABLE';await api(`${claim.snapshotId}/reject`,{input:{workerId,reason}}).catch(()=>undefined);}
  throw error;
 }finally{clearTimeout(deadline);stopped=true;pulseStop.abort();await pulse;signal?.removeEventListener('abort',abort);await reservation?.release();}
}
export async function runSnapshotRunner({directory,catalogUrl,image,tokenFile,once=false,signal}){
 process.umask(0o077);directory=path.resolve(directory);await fs.mkdir(directory,{recursive:true,mode:0o700});const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077)throw new Error('UNSAFE_RUNNER_DIRECTORY');
 if((await sweepSnapshotStages(directory,{signal})).unknown)throw new Error('UNSAFE_RUNNER_DIRECTORY');
 const token=(await privateSnapshotFile(tokenFile,1024)).toString('utf8').trim(),api=snapshotControl(catalogUrl,token),imageId=await snapshotVerifierImage(image),workerId=randomUUID();
 do{
  signal?.throwIfAborted();let claim;
  try{claim=await api('claim',{input:{workerId,sdkVersion:'0.29.0',imageDigest:imageId},signal});if(!claim)await api('gc',{signal});}
  catch(error){if(once||signal?.aborted)throw error;process.stderr.write('Каталог снимков временно недоступен.\n');await pause(3000,undefined,{signal});continue;}
  if(claim)try{await executeSnapshotVerification(claim,{api,workerId,imageId,directory,signal});}catch(error){if(signal?.aborted)throw error;process.stderr.write('Проверка снимка не завершена: '+(['FILES_CHANGED','LANCE_READ_FAILED','RESOURCE_LIMIT'].includes(error.message)?error.message:'CONTROL_OR_STORAGE_UNAVAILABLE')+'\n');}
  if(!once)await pause(3000,undefined,{signal});
 }while(!once);
}
async function main(){
 const options=process.argv.length===2?{directory:process.env.SNAPSHOT_RUNNER_DIRECTORY,catalogUrl:process.env.SNAPSHOT_RUNNER_CATALOG_URL,image:process.env.SNAPSHOT_RUNNER_IMAGE,tokenFile:process.env.SNAPSHOT_RUNNER_TOKEN_FILE}:{},names={'--directory':'directory','--catalog-url':'catalogUrl','--image':'image','--token-file':'tokenFile'},args=process.argv.slice(2);
 for(let index=0;index<args.length;index++){if(args[index]==='--once'){options.once=true;continue;}const key=names[args[index]];if(!key||options[key]!==undefined||!args[index+1])throw new Error('INVALID_ARGUMENTS');options[key]=args[++index];}
 if(!options.directory||!options.catalogUrl||!options.image||!options.tokenFile)throw new Error('INVALID_CONFIGURATION');
 const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{await runSnapshotRunner({...options,signal:controller.signal});}catch(error){if(!controller.signal.aborted)throw error;}finally{process.off('SIGTERM',stop);process.off('SIGINT',stop);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Исполнитель снимков остановлен: проверьте закрытую конфигурацию и связь с каталогом.');process.exitCode=1;});
