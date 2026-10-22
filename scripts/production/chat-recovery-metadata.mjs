import {chatRecoveryHash,chatRecoveryBucket} from './chat-recovery-config.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const scope=value=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=1024&&!/[\x00-\x1f\x7f]/.test(value);
const size=value=>Number.isSafeInteger(value)&&value>=1&&value<=10*1024**2;
const coreKeys=['id','storageId','bucket','objectKey','versionId','sha256','bytes','state'];
const liveKeys=[...coreKeys,'attachmentId','conversationId','ownerEmail','projectId'];
export const chatObjectFile=id=>'chat-objects/'+id+'.blob';
export const chatObjectKey=(project,owner,conversation,id)=>(project?'projects/'+chatRecoveryHash(project)+'/':'')+'owners/'+chatRecoveryHash(owner)+'/chats/'+conversation+'/'+id;
const sorted=rows=>rows.sort((a,b)=>(a.id||a.attachmentId).localeCompare(b.id||b.attachmentId));
function unique(rows,key,label){if(new Set(rows.map(row=>row[key])).size!==rows.length)throw Error('Повтор '+label+' в описи chat recovery.');}
export function chatObject(row){
    if(!exact(row,coreKeys)||!uuid(row.id)||!sha(row.storageId)||!chatRecoveryBucket(row.bucket)||!sha(row.sha256)||!size(row.bytes)||!['STAGING','LIVE','DELETE','DELETED'].includes(row.state)
        ||typeof row.objectKey!=='string'||!new RegExp('^(?:projects/[a-f0-9]{64}/)?owners/[a-f0-9]{64}/chats/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/'+row.id+'$').test(row.objectKey)
        ||row.versionId!==null&&(typeof row.versionId!=='string'||!row.versionId||row.versionId==='null'||row.versionId.length>1024||/[\x00-\x1f\x7f]/.test(row.versionId)))throw Error('Некорректная точная identity объекта chat recovery.');
    return Object.fromEntries(coreKeys.map(key=>[key,row[key]]));
}
function liveObject(row){
    if(!exact(row,liveKeys)||!uuid(row.attachmentId)||!uuid(row.conversationId)||!scope(row.ownerEmail)||row.projectId!==null&&!scope(row.projectId))throw Error('Некорректный владелец файла chat recovery.');
    const core=chatObject(Object.fromEntries(coreKeys.map(key=>[key,row[key]])));if(core.state!=='LIVE'||core.objectKey!==chatObjectKey(row.projectId,row.ownerEmail,row.conversationId,row.id))throw Error('Файл chat recovery относится к другому владельцу или проекту.');
    return{...core,attachmentId:row.attachmentId,conversationId:row.conversationId,ownerEmail:row.ownerEmail,projectId:row.projectId};
}
/** Every retained S3 object belongs to one live attachment and its actual conversation owner. */
export function chatMetadata(raw){
    if(!raw||['objects','attachments','conversations','transfers'].some(key=>!Array.isArray(raw[key])||raw[key].length>100000))throw Error('Превышена или отсутствует опись chat recovery.');
    const objects=raw.objects.map(chatObject),byId=new Map(objects.map(row=>[row.id,row])),conversations=new Map(),used=new Set(),records=[],pending=new Map(),deleted=new Map();unique(objects,'id','объекта');
    for(const row of raw.conversations){if(!uuid(row.id)||!scope(row.ownerEmail)||row.projectId!==null&&!scope(row.projectId)||conversations.has(row.id))throw Error('Некорректная область диалога chat recovery.');conversations.set(row.id,row);}
    unique(raw.attachments,'id','вложения');
    for(const row of raw.attachments){
        if(!uuid(row.id)||!uuid(row.conversationId)||!size(row.bytes)||!['S3','TRANSFER','DELETED','LEGACY'].includes(row.storageState)||row.objectId!==null&&!uuid(row.objectId)||row.deletedAt!==null&&(typeof row.deletedAt!=='string'||!Number.isFinite(Date.parse(row.deletedAt))))throw Error('Некорректная ссылка вложения chat recovery.');
        if(row.deletedAt!==null){if(row.objectId!==null||!['DELETED','LEGACY'].includes(row.storageState))throw Error('Удалённое вложение сохраняет S3 ссылку.');deleted.set(row.id,row);continue;}
        const conversation=conversations.get(row.conversationId);if(!conversation)throw Error('У вложения нет владельца диалога.');
        if(['TRANSFER','LEGACY'].includes(row.storageState)){if(row.objectId!==null)throw Error('Legacy вложение не должно ссылаться на S3.');if(row.storageState==='TRANSFER')pending.set(row.id,{row,conversation});continue;}
        const object=byId.get(row.objectId);if(row.storageState!=='S3'||!object||object.state!=='LIVE'||row.bytes!==object.bytes||used.has(object.id))throw Error('У вложения нет единственного LIVE оригинала с точным размером.');
        used.add(object.id);records.push(liveObject({...object,attachmentId:row.id,conversationId:row.conversationId,ownerEmail:conversation.ownerEmail,projectId:conversation.projectId}));
    }
    const discarded=objects.filter(row=>!used.has(row.id));if(discarded.some(row=>row.state==='LIVE'))throw Error('LIVE объект чата не имеет ссылки вложения.');
    unique(raw.transfers,'attachmentId','переноса');const transfers=raw.transfers.map(row=>{const tombstone=deleted.get(row.attachmentId),source=pending.get(row.attachmentId)||(tombstone&&{row:tombstone,conversation:conversations.get(tombstone.conversationId)});if(!source?.conversation||!sha(row.sha256)||!size(row.bytes)||row.bytes!==source.row.bytes||row.contentBytes!==row.bytes||row.contentSha256!==row.sha256)throw Error('Legacy перенос чата не имеет точных исходных bytes/SHA.');
        pending.delete(row.attachmentId);return{attachmentId:row.attachmentId,conversationId:source.row.conversationId,ownerEmail:source.conversation.ownerEmail,projectId:source.conversation.projectId,sha256:row.sha256,bytes:row.bytes,deleted:!!tombstone};});
    if(pending.size)throw Error('Legacy вложение чата не имеет исходных bytes.');
    return{objects:sorted(records),discardedObjects:sorted(discarded),transfers:sorted(transfers)};
}
export async function readChatMetadata(sql){
    const exists=(await sql('catalog',"SELECT to_regclass('public.model_chat_objects') IS NOT NULL;")).trim();if(exists==='f')return{objects:[],discardedObjects:[],transfers:[]};if(exists!=='t')throw Error('Не удалось проверить chat storage SQL.');
    const select=async(table,fields)=>JSON.parse(await sql('catalog',`SELECT coalesce(json_agg(json_build_object(${fields})),'[]'::json) FROM ${table};`));
    return chatMetadata({objects:await select('model_chat_objects',"'id',id,'storageId',storage_id,'bucket',bucket,'objectKey',object_key,'versionId',version_id,'sha256',sha256,'bytes',bytes,'state',state"),
        attachments:await select('model_chat_attachments',"'id',id,'conversationId',conversation_id,'objectId',object_id,'storageState',storage_state,'bytes',bytes,'deletedAt',deleted_at"),
        conversations:await select('model_chat_conversations',"'id',id,'ownerEmail',owner_email,'projectId',project_id"),
        transfers:await select('model_chat_attachment_transfers',"'attachmentId',attachment_id,'sha256',sha256,'bytes',bytes,'contentSha256',encode(sha256(content),'hex'),'contentBytes',octet_length(content)")});
}
export function validateChatInventory(value,entries){
    if(!exact(value,['schemaVersion','source','objects','discardedObjects','transfers'])||value.schemaVersion!==1||['objects','discardedObjects','transfers'].some(key=>!Array.isArray(value[key])||value[key].length>100000))throw Error('Recovery-v4 требует полную опись оригиналов чата.');
    if(value.source!==null&&(!exact(value.source,['storageId','projectBucket','personalBucket'])||!sha(value.source.storageId)||![value.source.projectBucket,value.source.personalBucket].every(chatRecoveryBucket)||value.source.projectBucket===value.source.personalBucket))throw Error('Некорректная identity двух исходных бакетов чата.');
    const objects=value.objects.map(item=>{if(!exact(item,[...liveKeys,'file'])||item.file!==chatObjectFile(item.id))throw Error('Некорректный путь оригинала чата.');const{file,...row}=item;return{...liveObject(row),file};});
    const discarded=value.discardedObjects.map(chatObject);if(discarded.some(row=>row.state==='LIVE'))throw Error('LIVE объект нельзя удалить как source-only intent.');
    unique([...objects,...discarded],'id','объекта');unique(objects,'attachmentId','вложения');
    for(const row of value.transfers)if(!exact(row,['attachmentId','conversationId','ownerEmail','projectId','sha256','bytes','deleted'])||!uuid(row.attachmentId)||!uuid(row.conversationId)||!scope(row.ownerEmail)||row.projectId!==null&&!scope(row.projectId)||!sha(row.sha256)||!size(row.bytes)||typeof row.deleted!=='boolean')throw Error('Некорректная опись legacy переноса чата.');
    for(const row of [...objects,...discarded])if(!value.source||row.storageId!==value.source.storageId||row.bucket!==(row.objectKey.startsWith('projects/')?value.source.projectBucket:value.source.personalBucket))throw Error('Опись содержит foreign chat storage identity.');
    unique([...objects,...value.transfers],'attachmentId','вложения');
    const files=new Map(entries.filter(entry=>entry.type==='file').map(entry=>[entry.path,entry])),allowed=new Set(objects.map(row=>row.file));
    for(const row of objects){const file=files.get(row.file);if(!file||file.mode!==0o600||file.size!==row.bytes||file.sha256!==row.sha256)throw Error('В комплекте нет закрытых exact bytes/SHA оригинала чата.');}
    for(const entry of entries.filter(entry=>entry.path.split('/')[0]==='chat-objects'))if(entry.path==='chat-objects'?entry.type!=='directory'||entry.mode!==0o700:entry.type!=='file'||!allowed.has(entry.path))throw Error('Посторонний или открытый файл chat recovery.');
    return value;
}
