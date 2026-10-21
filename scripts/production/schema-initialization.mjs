import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,writeFile,rename,rm,open,mkdtemp} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {applicationServices,composeClient,composeConfiguration,containers,serviceImageIds} from './compose-client.mjs';
import {schemaServices} from './schema-migrations.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const updateRequired=()=>new Error('Есть неприменённые миграции в существующем стеке. Используйте production update с копией и остановкой приложений.');
const invalid=()=>new Error('Не подтверждена квитанция первоначальной инициализации. Проверьте её владельца, конфигурацию и состояние стека.');
const uid=()=>process.getuid?.()??0;
const digestPattern=/^[a-f0-9]{64}$/;
const identitySql=`SELECT json_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
    'databases',(SELECT json_object_agg(datname,oid::text ORDER BY datname) FROM pg_database WHERE datname IN ('catalog','rag')))`;

async function privateBytes(filename){
    let handle;
    try{handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if(error.code==='ENOENT')throw error;throw invalid();}
    try{
        const info=await handle.stat();
        if(!info.isFile()||info.nlink!==1||info.mode&0o077||info.uid!==uid()||info.size>65536)throw invalid();
        return await handle.readFile('utf8');
    }finally{await handle.close();}
}

function validateReceipt(receipt,projectName){
    if(receipt?.format!=='neurocenter-schema-initialization-v1'||receipt.projectName!==projectName||receipt.ownerUid!==uid()
        ||!(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/).test(receipt.requestKey||'')
        ||!['initializing','schema-ready'].includes(receipt.state)||!Number.isFinite(Date.parse(receipt.createdAt||'')))throw invalid();
    const binding=receipt.binding;
    if(!binding||!digestPattern.test(binding.envSha256||'')||!digestPattern.test(binding.configSha256||'')
        ||Object.keys(binding.images||{}).length!==applicationServices.length
        ||applicationServices.some(service=>!/^sha256:[a-f0-9]{64}$/.test(binding.images[service]||''))
        ||!(/^[1-9][0-9]{0,19}$/).test(binding.cluster?.systemIdentifier||'')
        ||Object.keys(binding.cluster?.databases||{}).sort().join(',')!=='catalog,rag'
        ||['catalog','rag'].some(name=>!(/^[1-9][0-9]{0,9}$/).test(binding.cluster.databases[name]||'')))throw invalid();
    if(receipt.state==='schema-ready'&&!Number.isFinite(Date.parse(receipt.schemaReadyAt||'')))throw invalid();
    return receipt;
}

async function receiptAt(filename,projectName){
    let raw;
    try{raw=await privateBytes(filename);}catch(error){if(error.code==='ENOENT')return;throw error;}
    let receipt;try{receipt=JSON.parse(raw);}catch{throw invalid();}
    return {receipt:validateReceipt(receipt,projectName),raw};
}

async function bindingFor(directory,client,config){
    const images=await serviceImageIds(config);
    const raw=await client.run(['exec','-T','postgres','psql','-X','-U','nc_owner','-d','postgres','-v','ON_ERROR_STOP=1','-At'],{input:identitySql});
    let cluster;try{cluster=JSON.parse(raw);}catch{throw invalid();}
    return {envSha256:sha(await privateBytes(path.join(directory,'.env'))),configSha256:sha(JSON.stringify(canonical(config))),images,cluster};
}

async function noApplicationContainers(client){
    if((await containers(client)).some(item=>applicationServices.includes(item.Config?.Labels?.['com.docker.compose.service'])))throw new Error('Первоначальную инициализацию нельзя продолжить при существующих контейнерах приложений, включая остановленные. Используйте production update и проверьте квитанцию.');
}

async function atomicReceipt(filename,value){
    const temporary=filename+'.'+randomUUID()+'.tmp';
    try{
        await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});await rename(temporary,filename);
        const handle=await open(path.dirname(filename),'r');try{await handle.sync();}finally{await handle.close();}
    }finally{await rm(temporary,{force:true});}
}

/** Only an exact attempt first claimed on an empty cluster can resume partial fresh DDL. */
export async function prepareSchemaInitialization({directory,projectName,client,config,schemas}){
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077||info.uid!==uid())throw invalid();
    const filename=path.join(directory,'schema-initialization.json');
    let stored=await receiptAt(filename,projectName);
    const pending=Object.values(schemas).some(schema=>!schema.ready||schema.pending.length>0);
    if(stored?.receipt.state==='schema-ready'){
        if(pending)throw updateRequired();return;
    }
    if(!stored&&!pending)return;
    if(!stored&&Object.values(schemas).some(schema=>schema.existingSchema||schema.applied.length>0))throw updateRequired();
    await noApplicationContainers(client);
    const binding=await bindingFor(directory,client,config);
    if(stored){
        if(!isDeepStrictEqual(stored.receipt.binding,binding))throw invalid();
    }else{
        const receipt={format:'neurocenter-schema-initialization-v1',projectName,ownerUid:uid(),requestKey:randomUUID(),state:'initializing',createdAt:new Date().toISOString(),binding};
        validateReceipt(receipt,projectName);
        await writeFile(filename,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
        const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}
        stored=await receiptAt(filename,projectName);
    }
    if(!stored)throw invalid();
    const expected=stored,temporary=await mkdtemp(path.join(os.tmpdir(),'neurocenter-schema-initialization-'));
    const overlay=path.join(temporary,'pinned-schemas.json');
    try{await writeFile(overlay,JSON.stringify({services:Object.fromEntries(schemaServices.map(service=>[service,{image:binding.images[service]}]))}),{flag:'wx',mode:0o600});}
    catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
    const pinned=composeClient({directory,projectName,files:[overlay]});
    const assertCurrent=async()=>{
        await noApplicationContainers(client);
        const currentConfig=await composeConfiguration(client);
        if(!isDeepStrictEqual(await bindingFor(directory,client,currentConfig),expected.receipt.binding))throw invalid();
    };
    return {client:pinned,requestKey:expected.receipt.requestKey,assertCurrent,close:()=>rm(temporary,{recursive:true,force:true}),complete:async()=>{
        await assertCurrent();
        const current=await receiptAt(filename,projectName);
        if(!current||current.receipt.requestKey!==expected.receipt.requestKey||!isDeepStrictEqual(current.receipt.binding,expected.receipt.binding))throw invalid();
        if(current.receipt.state==='schema-ready')return;
        if(current.raw!==expected.raw)throw invalid();
        await atomicReceipt(filename,{...current.receipt,state:'schema-ready',schemaReadyAt:new Date().toISOString()});
    }};
}
