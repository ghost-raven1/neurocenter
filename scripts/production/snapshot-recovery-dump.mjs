import {createReadStream} from 'node:fs';
import {mkdtemp,lstat,rm,realpath} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {snapshotBlobs,assertSnapshotReferences} from './snapshot-recovery-metadata.mjs';
import {digestFile} from './recovery-files.mjs';

export function decodeCopyField(value){
 if(value==='\\N')return null;let output='';for(let index=0;index<value.length;index++){
  if(value[index]!=='\\'){output+=value[index];continue;}const next=value[++index];if(next===undefined)throw new Error('Некорректный COPY escape.');
  if(/[0-7]/.test(next)){const match=value.slice(index).match(/^[0-7]{1,3}/)[0];output+=String.fromCharCode(parseInt(match,8));index+=match.length-1;continue;}
  output+=({'\\':'\\',t:'\t',n:'\n',r:'\r',b:'\b',f:'\f',v:'\v'}[next]??next);
 }return output;
}
/** Only fixed COPY tables/columns are decoded. Statements from the archive are never executed. */
export async function readSnapshotCopy(filename,table,{blobStates}={}){
 if(!['project_snapshot_blob_writes','project_snapshot_blobs','project_snapshot_blob_refs','project_snapshots','project_snapshot_profiles'].includes(table))throw new Error('Неизвестная таблица снимков.');
 const stat=await lstat(filename);if(!stat.isFile()||stat.nlink!==1||stat.size>512*1024**2)throw new Error('Опись снимков в дампе превышает допустимый размер.');
 const input=createReadStream(filename),lines=createInterface({input,crlfDelay:Infinity});let columns,finished=false,sawTable=false;const rows=[];
 try{for await(const line of lines){
  if(Buffer.byteLength(line)>64*1024**2)throw new Error('Строка описи снимка превышает64 МиБ.');
  if(line.includes('Data for Name: '+table+';'))sawTable=true;
  const header=new RegExp('^COPY public\\.'+table+' \\(([^)]+)\\) FROM stdin;$').exec(line);
  if(header){if(columns||finished)throw new Error('Повтор COPY снимков.');columns=header[1].split(', ');const required=table==='project_snapshot_blob_writes'?['project_id','sha256','write_id','bytes','storage_id']:table==='project_snapshot_blobs'?['project_id','sha256','bytes','storage_id','version_id']:table==='project_snapshot_blob_refs'?['snapshot_id','project_id','sha256','bytes']:table==='project_snapshots'?['id','status','signature']:['signature'];if(columns.length>100||columns.some(name=>!/^[_a-z][_a-z0-9]*$/.test(name))||required.some(name=>!columns.includes(name))||new Set(columns).size!==columns.length)throw new Error('Неизвестная схема снимков в дампе.');continue;}
  if(columns&&!finished){if(line==='\\.'){finished=true;continue;}const values=line.split('\t');if(values.length!==columns.length)throw new Error('Неверное число COPY полей.');const field=name=>decodeCopyField(values[columns.indexOf(name)]);
   if(table==='project_snapshot_blob_writes')throw new Error('Дамп содержит незавершённую запись блока снимка. Дождитесь штатной очистки и создайте новую полную копию.');
   if(['project_snapshot_blobs','project_snapshot_blob_refs'].includes(table)&&!/^\d{1,9}$/.test(field('bytes')??''))throw new Error('Некорректный COPY размер блока.');
   if(table==='project_snapshot_blobs'){const row={projectId:field('project_id'),sha256:field('sha256'),bytes:Number(field('bytes')),storageId:field('storage_id'),versionId:field('version_id')};rows.push(row);if(blobStates){const state=columns.includes('state')?field('state'):'LIVE';if(!['LIVE','DELETING'].includes(state))throw new Error('Некорректное состояние блока снимка.');blobStates.set(row.projectId+'\0'+row.sha256,state);}}
   else if(table==='project_snapshot_blob_refs')rows.push({snapshotId:field('snapshot_id'),projectId:field('project_id'),sha256:field('sha256'),bytes:Number(field('bytes'))});
   else if(table==='project_snapshots'){const status=field('status');if(!['UPLOADING','VERIFYING','VERIFIED','REJECTED','DELETING','DELETED'].includes(status))throw new Error('Некорректное состояние полного снимка.');rows.push({id:field('id'),status,signature:field('signature')===null?null:JSON.parse(field('signature'))});}
   else{const signature=field('signature');if(signature!==null)rows.push(JSON.parse(signature));}if(rows.length>200000)throw new Error('Слишком много записей снимков.');
  }else if(new RegExp('^INSERT INTO (?:public\\.)?'+table+'\\b').test(line))throw new Error('Для снимков требуется штатный COPY формат дампа.');
 }if(columns&&!finished||sawTable&&!columns)throw new Error('Дамп снимков усечён или имеет неизвестный формат.');return table==='project_snapshot_blobs'?snapshotBlobs(rows):rows;
 }finally{lines.close();input.destroy();}
}
export async function dumpSnapshotMetadata(source,manifest,run){
 const catalog=manifest.entries.find(entry=>entry.path==='databases/catalog.dump'),filename=path.join(source,'databases/catalog.dump');
 if(!catalog||await digestFile(filename)!==catalog.sha256)throw new Error('Дамп каталога изменился.');
 const temporary=await realpath(await mkdtemp(path.join(tmpdir(),'neurocenter-recovery-metadata-'))),result={blobs:[],signatures:[]},blobStates=new Map();let snapshots=[];
 try{for(const table of ['project_snapshot_blob_writes','project_snapshot_blobs','project_snapshots','project_snapshot_blob_refs','project_snapshot_profiles']){
  const output=path.join(temporary,table+'.copy');await run(['run','--rm','--network','none','--read-only','--memory','256m','--cpus','1','--pids-limit','32','--cap-drop','ALL','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges','--mount',`type=bind,source=${source},target=/backup,readonly`,manifest.postgresImage,'pg_restore','--data-only','--schema=public','--table='+table,'--file=-','/backup/databases/catalog.dump'],{outputFile:output});
  const rows=await readSnapshotCopy(output,table,{blobStates});if(table==='project_snapshot_blobs')result.blobs=rows;else if(table==='project_snapshot_blob_refs')assertSnapshotReferences(result.blobs,rows,{snapshots,blobStates});else if(table==='project_snapshots'){snapshots=rows;result.signatures.push(...rows.map(row=>row.signature).filter(Boolean));}else if(table==='project_snapshot_profiles')result.signatures.push(...rows);
 }if(await digestFile(filename)!==catalog.sha256)throw new Error('Дамп каталога изменился во время проверки.');return result;
 }finally{await rm(temporary,{recursive:true,force:true});}
}
