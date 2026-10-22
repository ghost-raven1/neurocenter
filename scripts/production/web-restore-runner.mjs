#!/usr/bin/env node
import {readFile,lstat,readdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import contract from '../../services/shared/web-restore.cjs';
import {repositoryRoot} from './compose-client.mjs';
import {restoreCheckpoints,privateJson} from './restore-checkpoints.mjs';
import {executeWebRestoreJob,restoreJournalDirectory,acknowledgeRestoreJournal} from './web-restore-job.mjs';
import {snapshotRecoveryFingerprint} from './snapshot-recovery-config.mjs';
import {chatRecoveryFingerprint} from './chat-recovery-config.mjs';

/** Конфиг — только operator-owned файлы; API/браузер не выбирают Compose и серверные пути. */
export async function restoreRunnerConfiguration({directory,backupRoot,targetPrefix='neurocenter-restore',registry,files=[]}){
 if(!contract.project(targetPrefix)||targetPrefix.length>40)throw new Error('Некорректный префикс нового стека.');
 const sources=[path.join(directory,'.env'),path.join(directory,'secrets/model_credential_key'),path.join(repositoryRoot,'compose.production.yml'),...files];
 const digests=[];for(const filename of sources){const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>4*1024*1024)throw new Error('Небезопасный файл конфигурации восстановления.');
  if(filename.startsWith(path.resolve(directory)+path.sep)&&info.mode&0o077)throw new Error('Production конфигурация должна быть закрыта.');const bytes=await readFile(filename),after=await lstat(filename);if(info.size!==after.size||info.mtimeMs!==after.mtimeMs||info.ino!==after.ino)throw new Error('Конфигурация изменилась при чтении.');digests.push({file:path.resolve(filename),sha256:createHash('sha256').update(bytes).digest('hex')});}
 return {targetPrefix,configDigest:contract.digest({targetPrefix,sources:digests,snapshotRecovery:await snapshotRecoveryFingerprint(directory),chatRecovery:await chatRecoveryFingerprint(directory)}),checkpoints:await restoreCheckpoints({directory,backupRoot,registry})};
}
export function restoreRunnerApi(origin,token,request=fetch){
 const url=new URL(origin);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||typeof token!=='string'||token.length<32||token.length>256||/[\x00-\x20\x7f]/.test(token))throw new Error('Нужен доверенный HTTPS endpoint каталога (или loopback HTTP) и закрытый токен runner.');
 return async(route,input)=>{
  const response=await request(url.origin+'/internal/maintenance/restore/'+route,{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-neurocenter-restore':token},body:JSON.stringify(input),signal:AbortSignal.timeout(15000)});
  if(!response.ok){await response.body?.cancel();throw new Error('RESTORE_CONTROL_'+response.status);}
  const declared=response.headers.get('content-length');if(declared&&Number(declared)>16*1024*1024){await response.body?.cancel();throw new Error('Слишком большой ответ restore control.');}
  const reader=response.body.getReader(),chunks=[];let bytes=0;try{for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.length;if(bytes>16*1024*1024)throw new Error('Слишком большой ответ restore control.');chunks.push(item.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
 };
}
export async function runWebRestoreRunner(options){
 const {directory,backupRoot,registry,catalogUrl,targetPrefix='neurocenter-restore',files=[],once=false}=options;
 let token=process.env.RESTORE_RUNNER_TOKEN;
 if(process.env.RESTORE_RUNNER_TOKEN_FILE){if(token)throw new Error('Задайте только RESTORE_RUNNER_TOKEN_FILE.');const filename=process.env.RESTORE_RUNNER_TOKEN_FILE,info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.mode&0o077||info.size>1024)throw new Error('Небезопасный файл токена runner.');token=(await readFile(filename,'utf8')).trim();}
 const api=restoreRunnerApi(catalogUrl,token),runnerId=randomUUID(),stateDirectory=await restoreJournalDirectory(path.join(directory,'web-restore-runner'));
 const configuration=()=>restoreRunnerConfiguration({directory,backupRoot,registry,targetPrefix,files});
 let stopped=false;const stop=()=>{stopped=true;};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{do{
  const current=await configuration();await api('report',{runnerId,configDigest:current.configDigest,targetPrefix,checkpoints:current.checkpoints.map(({source,...publicInfo})=>publicInfo)});
  for(const name of await readdir(stateDirectory)){if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;const file=path.join(stateDirectory,name),saved=await privateJson(file,16*1024*1024);if(saved.phase==='complete')await acknowledgeRestoreJournal(file,api);}
  const {job}=await api('claim',{runnerId});if(job){
   try{await executeWebRestoreJob(job,{api,configuration,checkpoints:current.checkpoints,directory,backupRoot,stateDirectory,files});}
   catch(error){
    let saved;try{saved=await privateJson(path.join(stateDirectory,job.id+'.json'),16*1024*1024);}catch(readError){if(readError.code!=='ENOENT')throw readError;}
    if(saved)throw error; // Журнал/ACK неизвестен: executor повторно не запускается.
    await api(`jobs/${job.id}/complete`,{runnerId:job.runner_id,leaseId:job.lease_id,state:'failed',errorCode:contract.restoreFailureCode(error)});
   }
  }
  if(!once&&!stopped)await new Promise(resolve=>setTimeout(resolve,3000));
 }while(!once&&!stopped);}finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
async function main(){
 process.umask(0o077);const options={},names={'--directory':'directory','--backup-root':'backupRoot','--registry':'registry','--catalog-url':'catalogUrl','--target-prefix':'targetPrefix'};
 const args=process.argv.slice(2);for(let index=0;index<args.length;index++){if(args[index]==='--once'){options.once=true;continue;}const key=names[args[index]];if(!key||!args[index+1]||options[key]!==undefined)throw new Error('Параметры runner: --directory, --backup-root, --catalog-url; optional --registry, --target-prefix, --once.');options[key]=args[++index];}
 if(!options.directory||!options.backupRoot||!options.catalogUrl)throw new Error('Нужны --directory, --backup-root и --catalog-url.');options.directory=path.resolve(options.directory);options.backupRoot=path.resolve(options.backupRoot);if(options.registry)options.registry=path.resolve(options.registry);
 await runWebRestoreRunner(options);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Исполнитель восстановления остановлен. Проверьте закрытую конфигурацию, журнал и связь с каталогом; существующий стек не заменяется.');process.exitCode=1;});
