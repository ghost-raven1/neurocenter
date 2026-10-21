import {writeFile,rename,rm,open,lstat,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import contract from '../../services/shared/web-restore.cjs';
import {previewRestoreProduction,restoreProduction} from './recovery.mjs';
import {reserveRestoreSource,releaseSavedRestoreSource} from './restore-reservations.mjs';
import {privateJson} from './restore-checkpoints.mjs';

async function writeJournal(filename,value){
 const temporary=filename+'.'+randomUUID()+'.tmp';
 try{await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600,flush:true});await rename(temporary,filename);const handle=await open(path.dirname(filename),'r');try{await handle.sync();}finally{await handle.close();}}
 finally{await rm(temporary,{force:true});}
}
export async function restoreJournalDirectory(directory){
 await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077)throw new Error('Нужен закрытый каталог журнала восстановления.');return directory;
}
/** Durable результат отправляется повторно с прежней арендой; повторного executor нет. */
export async function acknowledgeRestoreJournal(filename,api){
 const saved=await privateJson(filename,16*1024*1024);
 if(!contract.uuid(saved.id)||!contract.uuid(saved.runnerId)||!contract.uuid(saved.leaseId)||saved.phase!=='complete'||!saved.result)throw new Error('Незавершённый restore journal требует операторской проверки.');
 await api(`jobs/${saved.id}/complete`,{runnerId:saved.runnerId,leaseId:saved.leaseId,...saved.result});
 await releaseSavedRestoreSource(saved.backupRoot,saved.source,saved.owner,saved.token);
 await rm(filename);
}
/** Единственная точка исполнения: проверка SHA/конфига/разрешения повторяется до первой записи. */
export async function executeWebRestoreJob(job,options,injected={}){
 const {api,configuration,checkpoints,directory,backupRoot,stateDirectory,files=[]}=options;
 const {preview=previewRestoreProduction,restore=restoreProduction,now=()=>new Date()}=injected;
 if(!job||!contract.uuid(job.id)||!contract.uuid(job.runner_id)||!contract.uuid(job.lease_id)||!['preview','restore'].includes(job.kind)||job.state!=='running')throw new Error('Некорректное задание восстановления.');
 const input=job.kind==='preview'?contract.previewRequest(job.input):contract.restoreRequest(job.input);
 const approved=job.kind==='restore'?contract.previewResult(job.preview):null;
 const selection=approved??input;
 const source=checkpoints.find(item=>item.id===selection.checkpointId&&item.sha256===selection.checkpointSha256);
 if(!source)throw new Error('Точная копия больше не зарегистрирована.');
 const current=await configuration();
 if(!selection.targetProject.startsWith(current.targetPrefix+'-')||approved&&(approved.configDigest!==current.configDigest||Date.parse(approved.expiresAt)<=now().getTime()||input.confirmation!=='RESTORE '+approved.targetProject))throw new Error('Проверка истекла или конфигурация изменилась.');
 const journal=path.join(await restoreJournalDirectory(stateDirectory),job.id+'.json');
 const owner=job.id+':'+job.lease_id,release=await reserveRestoreSource(backupRoot,source.source,owner);
 if(!release)throw new Error('Полная копия зарезервирована другим запуском или ожидает проверки после сбоя.');
 const saved={id:job.id,runnerId:job.runner_id,leaseId:job.lease_id,source:source.source,backupRoot,owner,token:release.token,phase:'running'};
 let message=job.kind==='preview'?'Проверяем копию и новое назначение.':'Проверяем разрешение перед восстановлением.';
 const pulse=()=>api(`jobs/${job.id}/pulse`,{runnerId:job.runner_id,leaseId:job.lease_id,message});
 let pulsing=false;const timer=setInterval(()=>{if(pulsing)return;pulsing=true;void pulse().catch(()=>undefined).finally(()=>{pulsing=false;});},5000);timer.unref();
 let completed=false,journalWritten=false;
 try{
  await writeJournal(journal,saved);journalWritten=true;await pulse();
  const production={directory,projectName:selection.targetProject,files,source:source.source,expectedHash:source.sha256,progress:value=>{message=value;}};
  let result;
  if(job.kind==='preview'){
   const checked=await preview(production),checkedAt=now(),body={checkpointId:source.id,checkpointSha256:source.sha256,targetProject:selection.targetProject,configDigest:current.configDigest,
    checkedAt:checkedAt.toISOString(),expiresAt:new Date(checkedAt.getTime()+10*60000).toISOString(),impact:{databases:checked.manifest.databases.map(db=>db.name),volumes:['skills','projects','backups','runtime-artifacts'],
     files:checked.manifest.entries.filter(entry=>entry.type==='file').length,bytes:checked.manifest.entries.reduce((total,entry)=>total+(entry.size||0),0),applicationsStarted:false,currentStackChanged:false}};
   if((await configuration()).configDigest!==current.configDigest)throw new Error('Конфигурация изменилась во время проверки.');
   result={state:'ready',preview:contract.previewResult({...body,digest:contract.digest(body)})};
  }else{
   const beforeMutation=async()=>{if((await configuration()).configDigest!==approved.configDigest)throw new Error('Конфигурация изменилась перед записью.');await pulse();};
   await beforeMutation();const receipt=contract.restoreReceipt(await restore({...production,beforeMutation}));
   if(receipt.sha256!==approved.checkpointSha256||receipt.projectName!==approved.targetProject||receipt.databases!==approved.impact.databases.length)throw new Error('Квитанция не соответствует подтверждённой проверке.');result={state:'succeeded',receipt};
  }
  await writeJournal(journal,{...saved,phase:'complete',result});completed=true;await acknowledgeRestoreJournal(journal,api);return result;
 }catch(error){
  if(!journalWritten){await release();throw error;}
  if(completed)throw error;
  // Executor мог уже создать частичный новый target. Повтор запрещён; статус и это ограничение сохраняются.
  const result={state:'failed',errorCode:contract.restoreFailureCode(error)};await writeJournal(journal,{...saved,phase:'complete',result});completed=true;
  await acknowledgeRestoreJournal(journal,api);return result;
 }finally{clearInterval(timer);}
}
