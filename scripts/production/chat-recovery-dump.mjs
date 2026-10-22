import {createReadStream} from 'node:fs';
import {mkdtemp,lstat,rm,realpath} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {decodeCopyField} from './snapshot-recovery-dump.mjs';
import {digestFile} from './recovery-files.mjs';
import {chatMetadata} from './chat-recovery-metadata.mjs';
import {chatRecoveryHash} from './chat-recovery-config.mjs';

const tables={model_chat_objects:['id','storage_id','bucket','object_key','version_id','sha256','bytes','state'],model_chat_attachments:['id','conversation_id','bytes','deleted_at'],model_chat_conversations:['id','owner_email','project_id'],model_chat_attachment_transfers:['attachment_id','content','sha256','bytes']};
function content(value,bytes){if(typeof value!=='string'||!/^\\x(?:[a-f0-9]{2})+$/.test(value)||value.length!==2+bytes*2)throw Error('Некорректные bytea bytes переноса чата.');return Buffer.from(value.slice(2),'hex');}
/** Decode only fixed COPY tables; archive SQL never executes during restore admission. */
export async function readChatCopy(filename,table){
    if(!tables[table])throw Error('Неизвестная таблица chat recovery.');const stat=await lstat(filename);if(!stat.isFile()||stat.nlink!==1||stat.size>512*1024**2)throw Error('Опись чата в дампе превышает512МиБ.');
    const input=createReadStream(filename),lines=createInterface({input,crlfDelay:Infinity}),rows=[];let columns,finished=false,sawTable=false;
    try{for await(const line of lines){
        if(Buffer.byteLength(line)>64*1024**2)throw Error('Строка chat COPY превышает64МиБ.');if(line.includes('Data for Name: '+table+';'))sawTable=true;
        const header=new RegExp('^COPY public\\.'+table+' \\(([^)]+)\\) FROM stdin;$').exec(line);
        if(header){if(columns||finished)throw Error('Повтор chat COPY.');columns=header[1].split(', ');if(columns.length>100||new Set(columns).size!==columns.length||columns.some(name=>!/^[_a-z][_a-z0-9]*$/.test(name))||tables[table].some(name=>!columns.includes(name)))throw Error('Неизвестная схема chat COPY.');
            if(table==='model_chat_attachments'&&(columns.includes('object_id')!==columns.includes('storage_state')||!columns.includes('object_id')&&!columns.includes('content')))throw Error('Неизвестная схема chat attachment storage.');continue;}
        if(columns&&!finished){if(line==='\\.'){finished=true;continue;}const values=line.split('\t');if(values.length!==columns.length)throw Error('Неверное число chat COPY полей.');const field=name=>decodeCopyField(values[columns.indexOf(name)]);
            let bytes;if(columns.includes('bytes')){if(!/^[0-9]{1,8}$/.test(field('bytes')??''))throw Error('Некорректный chat COPY размер.');bytes=Number(field('bytes'));if(bytes<1||bytes>10*1024**2)throw Error('Некорректный chat COPY размер.');}
            if(table==='model_chat_objects')rows.push({id:field('id'),storageId:field('storage_id'),bucket:field('bucket'),objectKey:field('object_key'),versionId:field('version_id'),sha256:field('sha256'),bytes,state:field('state')});
            else if(table==='model_chat_conversations')rows.push({id:field('id'),ownerEmail:field('owner_email'),projectId:field('project_id')});
            else if(table==='model_chat_attachment_transfers'){const original=content(field('content'),bytes);rows.push({attachmentId:field('attachment_id'),sha256:field('sha256'),bytes,contentSha256:chatRecoveryHash(original),contentBytes:original.length});}
            else{const legacy=!columns.includes('object_id'),deletedAt=field('deleted_at');if(legacy&&deletedAt===null)content(field('content'),bytes);rows.push({id:field('id'),conversationId:field('conversation_id'),bytes,objectId:legacy?null:field('object_id'),storageState:legacy?'LEGACY':field('storage_state'),deletedAt});}
            if(rows.length>100000)throw Error('Слишком много записей chat COPY.');
        }else if(new RegExp('^INSERT INTO (?:public\\.)?'+table+'\\b').test(line))throw Error('Chat recovery требует штатный COPY формат.');
    }if(columns&&!finished||sawTable&&!columns)throw Error('Chat COPY усечён или имеет неизвестный формат.');return rows;
    }finally{lines.close();input.destroy();}
}
/** Verify exact attachment ownership and transfer payloads before any target cluster or bucket exists. */
export async function dumpChatMetadata(source,manifest,run){
    const entry=manifest.entries.find(row=>row.path==='databases/catalog.dump'),filename=path.join(source,'databases/catalog.dump');if(!entry||await digestFile(filename)!==entry.sha256)throw Error('Дамп каталога изменился перед проверкой чата.');
    const temporary=await realpath(await mkdtemp(path.join(tmpdir(),'neurocenter-chat-recovery-'))),raw={};
    try{for(const[table,key]of[['model_chat_objects','objects'],['model_chat_attachments','attachments'],['model_chat_conversations','conversations'],['model_chat_attachment_transfers','transfers']]){
        const output=path.join(temporary,table+'.copy');await run(['run','--rm','--network','none','--read-only','--memory','256m','--cpus','1','--pids-limit','32','--cap-drop','ALL','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges','--mount',`type=bind,source=${source},target=/backup,readonly`,manifest.postgresImage,'pg_restore','--data-only','--schema=public','--table='+table,'--file=-','/backup/databases/catalog.dump'],{outputFile:output});raw[key]=await readChatCopy(output,table);
    }if(await digestFile(filename)!==entry.sha256)throw Error('Дамп каталога изменился во время проверки чата.');return chatMetadata(raw);
    }finally{await rm(temporary,{recursive:true,force:true});}
}
