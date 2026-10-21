import {createHash} from 'node:crypto';
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const hash=value=>createHash('sha256').update(value).digest('hex');
export const snapshotObjectKey=(project,sha256)=>'projects/'+hash(project)+'/blobs/'+sha256;
export const snapshotObjectFile=(project,sha256)=>'snapshot-objects/'+hash(project)+'/'+sha256+'.blob';
export const snapshotLocalFile=(project,sha256)=>'files/runtime-artifacts/.project-snapshots/'+hash(project)+'/'+sha256;

/** DB не задаёт endpoint, bucket или произвольное имя объекта. Путь выводится из project + content SHA. */
export function snapshotBlob(value){
 if(!exact(value,['projectId','sha256','bytes','storageId','versionId'])||typeof value.projectId!=='string'||!value.projectId||Buffer.byteLength(value.projectId)>1024||/[\x00]/.test(value.projectId)||!sha(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>64*1024*1024||typeof value.storageId!=='string'||!/^(?:s3|fs):[a-f0-9]{32}$/.test(value.storageId))throw new Error('Некорректная опись блоков полных снимков.');
 if(value.storageId.startsWith('s3:')&&(typeof value.versionId!=='string'||!value.versionId||value.versionId==='null'||value.versionId.length>1024||/[\x00-\x1f\x7f]/.test(value.versionId))||value.storageId.startsWith('fs:')&&value.versionId!==null)throw new Error('S3 блок требует точную immutable version; FS version должна быть null.');
 return {projectId:value.projectId,sha256:value.sha256,bytes:value.bytes,storageId:value.storageId,versionId:value.versionId};
}
export function snapshotBlobs(raw){
 if(!Array.isArray(raw)||raw.length>100000)throw new Error('Опись полных снимков превышает100000 блоков.');
 const rows=raw.map(snapshotBlob).sort((a,b)=>Buffer.compare(Buffer.from(a.projectId),Buffer.from(b.projectId))||a.sha256.localeCompare(b.sha256)),seen=new Set();
 for(const row of rows){const key=row.projectId+'\0'+row.sha256;if(seen.has(key))throw new Error('Повтор блока полного снимка.');seen.add(key);}return rows;
}
/** pg_restore --data-only выводится как текст и разбирается; SQL из дампа здесь не выполняется. */
export function snapshotRowsFromCopy(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>16*1024*1024)throw new Error('Опись блоков в дампе слишком велика.');
 const lines=raw.split(/\r?\n/);let columns=null,finished=false;const rows=[];
 const decode=value=>{
  if(value==='\\N')return null;let output='';for(let index=0;index<value.length;index++){
   if(value[index]!=='\\'){output+=value[index];continue;}const next=value[++index];if(next===undefined)throw new Error('Некорректный COPY escape.');
   if(/[0-7]/.test(next)){const match=value.slice(index).match(/^[0-7]{1,3}/)[0];output+=String.fromCharCode(parseInt(match,8));index+=match.length-1;continue;}
   output+=({'\\':'\\',t:'\t',n:'\n',r:'\r',b:'\b',f:'\f',v:'\v'}[next]??next);
  }return output;
 };
 for(const line of lines){
  const header=/^COPY public\.project_snapshot_blobs \(([^)]+)\) FROM stdin;$/.exec(line);
  if(header){if(columns||finished)throw new Error('Повтор COPY блоков снимков.');columns=header[1].split(', ');if(columns.length>100||columns.some(name=>!/^[_a-z][_a-z0-9]*$/.test(name))||['project_id','sha256','bytes','storage_id','version_id'].some(name=>!columns.includes(name))||new Set(columns).size!==columns.length)throw new Error('Неизвестная схема блоков полного снимка.');continue;}
  if(columns&&!finished){if(line==='\\.'){finished=true;continue;}const values=line.split('\t').map(decode);if(values.length!==columns.length)throw new Error('Неверное число COPY полей.');const row=Object.fromEntries(columns.map((name,index)=>[name,values[index]]));
   if(typeof row.bytes!=='string'||!/^\d{1,9}$/.test(row.bytes))throw new Error('Некорректный COPY размер блока.');rows.push({projectId:row.project_id,sha256:row.sha256,bytes:Number(row.bytes),storageId:row.storage_id,versionId:row.version_id});if(rows.length>100000)throw new Error('Слишком много блоков снимков.');
  }else if(/^INSERT INTO (?:public\.)?project_snapshot_blobs\b/.test(line))throw new Error('Дамп блоков требует штатный COPY формат.');
 }
 if(columns&&!finished||!columns&&/Data for Name: project_snapshot_blobs;/.test(raw))throw new Error('Дамп блоков снимков усечён или имеет неизвестный формат.');return snapshotBlobs(rows);
}
export async function readSnapshotBlobs(sql){
 const writes=(await sql('catalog',"SELECT to_regclass('public.project_snapshot_blob_writes') IS NOT NULL;")).trim();if(writes!=='f'&&(writes!=='t'||(await sql('catalog','SELECT count(*) FROM project_snapshot_blob_writes;')).trim()!=='0'))throw new Error('Есть незавершённая запись блока снимка. Дождитесь штатной очистки и повторите полную копию.');
 const exists=(await sql('catalog',"SELECT to_regclass('public.project_snapshot_blobs') IS NOT NULL;")).trim();if(exists==='f'){const refs=(await sql('catalog',"SELECT to_regclass('public.project_snapshot_blob_refs') IS NOT NULL;")).trim();if(refs!=='f'&&(refs!=='t'||(await sql('catalog',"SELECT count(*) FROM project_snapshot_blob_refs r JOIN project_snapshots s ON s.id=r.snapshot_id WHERE s.status IN ('VERIFYING','VERIFIED');")).trim()!=='0'))throw new Error('Ссылки полного снимка не имеют exact LIVE blob metadata и bytes.');return [];}
 if(exists!=='t')throw new Error('Не удалось проверить опись полных снимков.');
 const raw=await sql('catalog',"SELECT coalesce(json_agg(json_build_object('projectId',project_id,'sha256',sha256,'bytes',bytes,'storageId',storage_id,'versionId',version_id) ORDER BY project_id,sha256),'[]'::json) FROM project_snapshot_blobs;"),rows=snapshotBlobs(JSON.parse(raw));
 const refs=(await sql('catalog',"SELECT to_regclass('public.project_snapshot_blob_refs') IS NOT NULL;")).trim();if(refs!=='f'&&refs!=='t')throw new Error('Не удалось проверить ссылки блоков снимков.');
 if(refs==='t'&&(await sql('catalog',"SELECT count(*) FROM project_snapshot_blob_refs r JOIN project_snapshots s ON s.id=r.snapshot_id LEFT JOIN project_snapshot_blobs b ON b.project_id=r.project_id AND b.sha256=r.sha256 WHERE s.status IN ('VERIFYING','VERIFIED') AND (b.sha256 IS NULL OR b.bytes<>r.bytes OR b.state<>'LIVE');")).trim()!=='0')throw new Error('Ссылки полного снимка не имеют exact LIVE blob metadata и bytes.');return rows;
}
export function assertSnapshotReferences(blobs,references,{snapshots,blobStates}={}){
 const registered=new Map(blobs.map(row=>[row.projectId+'\0'+row.sha256,row.bytes])),statuses=snapshots&&new Map(snapshots.map(row=>[row.id,row.status]));for(const row of references){
  if(!exact(row,['snapshotId','projectId','sha256','bytes'])||typeof row.projectId!=='string'||!sha(row.sha256)||!Number.isSafeInteger(row.bytes))throw new Error('Некорректные ссылки полного снимка.');
  if(statuses){if(!statuses.has(row.snapshotId))throw new Error('Ссылка полного снимка не имеет metadata снимка.');if(!['VERIFYING','VERIFIED'].includes(statuses.get(row.snapshotId)))continue;}
  const key=row.projectId+'\0'+row.sha256;if(registered.get(key)!==row.bytes||blobStates&&blobStates.get(key)!=='LIVE')throw new Error('Ссылки полного снимка не имеют exact LIVE blob metadata и bytes.');
 }
}
export function validateSnapshotInventory(value,entries){
 if(!exact(value,['schemaVersion','blobs','keyFiles'])||value.schemaVersion!==1||!Array.isArray(value.blobs))throw new Error('Recovery-v3 требует полную опись snapshot objects.');
 const records=value.blobs.map(item=>{if(!exact(item,['projectId','sha256','bytes','storageId','versionId','file']))throw new Error('Посторонние поля snapshot object.');const {file,...metadata}=item,row=snapshotBlob(metadata),expected=row.storageId.startsWith('s3:')?snapshotObjectFile(row.projectId,row.sha256):snapshotLocalFile(row.projectId,row.sha256);if(file!==expected)throw new Error('Путь snapshot object не соответствует project/SHA.');return {...row,file};});
 snapshotBlobs(records.map(({file,...row})=>row));
 const files=new Map(entries.filter(entry=>entry.type==='file').map(entry=>[entry.path,entry]));
 for(const record of records){const entry=files.get(record.file);if(!entry||entry.size!==record.bytes||entry.sha256!==record.sha256)throw new Error('В комплекте нет exact bytes полного снимка.');}
 const objectFiles=new Set(records.filter(row=>row.storageId.startsWith('s3:')).map(row=>row.file));
 const objectDirectories=new Set([...objectFiles].flatMap(file=>['snapshot-objects',file.split('/').slice(0,2).join('/')]));
 if(entries.some(entry=>entry.path.split('/')[0]==='snapshot-objects'&&!(entry.type==='file'?objectFiles:objectDirectories).has(entry.path)))throw new Error('Посторонний файл или каталог snapshot objects.');
 if(value.keyFiles!==undefined&&(!Array.isArray(value.keyFiles)||value.keyFiles.some(file=>!['operatorsecrets/snapshot_signing_key','operatorsecrets/snapshot_trusted_keys.json'].includes(file)||!files.has(file))||new Set(value.keyFiles).size!==value.keyFiles.length))throw new Error('Некорректная опись ключей снимков.');
 const keys=new Set(value.keyFiles||[]);for(const entry of entries.filter(entry=>entry.path.split('/')[0]==='operatorsecrets'))if(entry.path==='operatorsecrets'?entry.type!=='directory'||entry.mode!==0o700:!keys.has(entry.path)||entry.type!=='file'||entry.mode!==0o600||entry.size<1||entry.size>(entry.path.endsWith('_key')?8192:65536))throw new Error('Ключи снимков требуют закрытую точную опись без посторонних файлов.');
 return value;
}
