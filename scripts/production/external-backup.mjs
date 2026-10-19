#!/usr/bin/env node
import https from 'node:https';
import dns from 'node:dns';
import {networkInterfaces} from 'node:os';
import {isIP} from 'node:net';
import {constants} from 'node:fs';
import {open,readFile,lstat,mkdir,mkdtemp,chmod,rename,rm,realpath} from 'node:fs/promises';
import {createHash,createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {verifyBackup,validateManifest,manifestDigest} from './recovery-manifest.mjs';

export const EXTERNAL_CHUNK_BYTES=32*1024*1024;
const MANIFEST_LIMIT=64*1024*1024;
const REMOTE_FORMAT='neurocenter-external-v1';
const manifestKey=backupId=>REMOTE_FORMAT+'/'+backupId+'/manifest.json';
const digest=value=>createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const encoded=value=>encodeURIComponent(value).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

function forbiddenAddress(address){
    const value=address.toLowerCase().replace(/^::ffff:/,'');
    return value==='::'||value==='::1'||value.startsWith('fe80:')||value.startsWith('ff')
        ||/^(0|127)\./.test(value)||value.startsWith('169.254.')||/^(22[4-9]|23[0-9]|24[0-9]|25[0-5])\./.test(value);
}

/** Независимость хранилища подтверждает оператор; URL сам по себе её не доказывает. */
export function externalBackupConfiguration(env=process.env){
    const required=key=>{const value=env['EXTERNAL_BACKUP_S3_'+key];if(typeof value!=='string'||!value||/[\x00-\x1f\x7f]/.test(value)){throw new Error('Нужен EXTERNAL_BACKUP_S3_'+key);}return value;};
    let endpoint;try{endpoint=new URL(required('ENDPOINT'));}catch{throw new Error('Нужен HTTPS endpoint внешнего S3');}
    const host=endpoint.hostname.toLowerCase();
    if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/'
        ||isIP(host.replace(/^\[|\]$/g,''))||!host.includes('.')||!/^[a-z0-9.-]+$/.test(host)||/(^|\.)(localhost|local|internal)$/.test(host)){
        throw new Error('Внешний S3 требует HTTPS DNS endpoint без пути, реквизитов и локального адреса');
    }
    const bucket=required('BUCKET'),region=required('REGION'),storageId=required('STORAGE_ID');
    if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||bucket.includes('..')||isIP(bucket)||!/^[a-z0-9-]{1,64}$/.test(region)||!validId(storageId)){
        throw new Error('Некорректные bucket, region или storage ID внешнего S3');
    }
    if(required('INDEPENDENT')!=='true'){throw new Error('Оператор должен подтвердить независимость внешнего S3');}
    return Object.freeze({endpoint:endpoint.origin,bucket,region,storageId,accessKeyId:required('ACCESS_KEY_ID'),secretAccessKey:required('SECRET_ACCESS_KEY'),
        ...(env.EXTERNAL_BACKUP_S3_SESSION_TOKEN?{sessionToken:required('SESSION_TOKEN')}:{})});
}

/** Подписывает конкретное тело SigV4; секреты не попадают в URL или квитанцию. */
export function signedS3Request(config,method,key,body=Buffer.alloc(0),at=new Date()){
    const date=at.toISOString().replace(/[:-]|\.\d{3}/g,'');const day=date.slice(0,8);
    const url=new URL(config.endpoint);url.pathname='/'+[config.bucket,...key.split('/')].map(encoded).join('/');
    const headers={host:url.host,'x-amz-content-sha256':digest(body),'x-amz-date':date};
    if(config.sessionToken){headers['x-amz-security-token']=config.sessionToken;}
    if(method==='PUT'){headers['if-none-match']='*';}
    const names=Object.keys(headers).sort(),signedHeaders=names.join(';');
    const canonical=[method,url.pathname,'',names.map(name=>name+':'+headers[name]+'\n').join(''),signedHeaders,headers['x-amz-content-sha256']].join('\n');
    const scope=day+'/'+config.region+'/s3/aws4_request';
    const signingKey=hmac(hmac(hmac(hmac('AWS4'+config.secretAccessKey,day),config.region),'s3'),'aws4_request');
    headers.authorization='AWS4-HMAC-SHA256 Credential='+config.accessKeyId+'/'+scope+', SignedHeaders='+signedHeaders+', Signature='+createHmac('sha256',signingKey).update('AWS4-HMAC-SHA256\n'+date+'\n'+scope+'\n'+digest(canonical)).digest('hex');
    if(method==='PUT'){headers['content-length']=String(body.length);headers['content-type']='application/octet-stream';}
    return {url,headers};
}

class StorageError extends Error{
    constructor(message,{status,code}={}){super(message);this.status=status;this.code=code;}
}
const transient=error=>[408,409,429,500,502,503,504].includes(error.status)||['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','EPIPE'].includes(error.code);

/** Повторяем только временные отказы, не ошибки TLS, подписи, SHA или доступа. */
export async function retryExternalOperation(operation,{wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
    for(let attempt=0;;attempt++){
        try{return await operation();}
        catch(error){if(attempt>=3||!transient(error)){throw error;}await wait(250*2**attempt);}
    }
}

function externalLookup(host,options,callback){
    dns.lookup(host,{...options,all:true},(error,addresses)=>{
        if(error){callback(error);return;}
        const local=new Set(Object.values(networkInterfaces()).flat().filter(Boolean).map(item=>item.address.toLowerCase()));
        if(!addresses.length||addresses.some(item=>forbiddenAddress(item.address)||local.has(item.address.toLowerCase()))){
            callback(new StorageError('S3 endpoint разрешился в адрес этой машины или локальной службы'));return;
        }
        if(options.all){callback(null,addresses);}else{callback(null,addresses[0].address,addresses[0].family);}
    });
}

/** HTTPS без redirect и ослабления TLS; ответ ограничен размером одного блока. */
export function createExternalS3Store(config){
    const request=(method,key,body=Buffer.alloc(0),limit=EXTERNAL_CHUNK_BYTES)=>retryExternalOperation(()=>new Promise((resolve,reject)=>{
        const {url,headers}=signedS3Request(config,method,key,body);
        const child=https.request(url,{method,headers,lookup:externalLookup,rejectUnauthorized:true,agent:false},response=>{
            response.on('error',reject);response.on('aborted',()=>reject(new StorageError('Ответ внешнего S3 прерван',{code:'ECONNRESET'})));
            if(response.statusCode<200||response.statusCode>=300){
                reject(new StorageError('Внешний S3 отклонил '+method+' (HTTP '+response.statusCode+')',{status:response.statusCode}));response.destroy();return;
            }
            const chunks=[];let size=0;
            response.on('data',chunk=>{size+=chunk.length;if(size>limit){response.destroy(new StorageError('Ответ внешнего S3 превышает допустимый размер'));}else{chunks.push(chunk);}});
            response.on('end',()=>resolve(Buffer.concat(chunks,size)));
        });
        const timer=setTimeout(()=>child.destroy(new StorageError('Истёк срок обращения к внешнему S3',{code:'ETIMEDOUT'})),120000);timer.unref();
        child.setTimeout(30000,()=>child.destroy(new StorageError('Внешний S3 не отвечает',{code:'ETIMEDOUT'})));
        child.on('error',reject);child.on('close',()=>clearTimeout(timer));child.end(body);
    }));
    return {
        put:async(key,body)=>{try{await request('PUT',key,body,64*1024);}catch(error){if(error.status!==412){throw error;}}},
        get:(key,limit)=>request('GET',key,undefined,limit),
    };
}

function validateInput({backupId,expectedHash}){
    if(!validId(backupId)||!validHash(expectedHash)){throw new Error('Нужны безопасный backup ID и сохранённый SHA256 описи');}
}
const objectKey=(backupId,entry,index)=>REMOTE_FORMAT+'/'+backupId+'/data/'+digest(entry.path)+'/'+String(index).padStart(8,'0');

async function checkedGet(store,key,size,sha256){
    const bytes=await store.get(key,size);
    if(bytes.length!==size||digest(bytes)!==sha256){throw new Error('SHA256 или размер внешнего объекта не совпадает с исходной копией');}
    return bytes;
}

/** Публикует опись последней, только после чтения и SHA-проверки каждого блока. */
export async function uploadExternalBackup({source,expectedHash,backupId,config=externalBackupConfiguration(),store=createExternalS3Store(config)}){
    validateInput({backupId,expectedHash});
    const manifest=await verifyBackup(source,expectedHash);
    if(manifest.format!=='neurocenter-recovery-v2'){throw new Error('Внешняя доставка требует полный recovery-v2 комплект');}
    const raw=await readFile(path.join(source,'manifest.json'));
    if(manifestDigest(raw)!==expectedHash){throw new Error('Опись изменилась после проверки');}
    let bytes=0,files=0;
    for(const entry of manifest.entries.filter(item=>item.type==='file')){
        const handle=await open(path.join(source,entry.path),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=await handle.stat();
        try{
            if(!before.isFile()||before.nlink!==1||before.size!==entry.size){throw new Error('Исходный файл изменился');}
            const full=createHash('sha256');let offset=0,index=0;
            while(offset<entry.size){
                const chunk=Buffer.alloc(Math.min(EXTERNAL_CHUNK_BYTES,entry.size-offset));let used=0;
                while(used<chunk.length){const read=await handle.read(chunk,used,chunk.length-used,offset+used);if(!read.bytesRead){throw new Error('Исходный файл усечён');}used+=read.bytesRead;}
                const key=objectKey(backupId,entry,index++);await store.put(key,chunk);
                full.update(await checkedGet(store,key,chunk.length,digest(chunk)));offset+=chunk.length;
            }
            const after=await handle.stat();
            if(full.digest('hex')!==entry.sha256||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||after.nlink!==1){throw new Error('SHA256 исходного файла изменился во время передачи');}
            bytes+=entry.size;files++;
        }finally{await handle.close();}
    }
    // Повторная полная проверка не даёт опубликовать изменённое дерево или новый посторонний файл.
    await verifyBackup(source,expectedHash);
    await store.put(manifestKey(backupId),raw);await checkedGet(store,manifestKey(backupId),raw.length,expectedHash);
    return {ok:true,backupId,storageId:config.storageId,manifestSha256:expectedHash,createdAt:manifest.createdAt,verifiedAt:new Date().toISOString(),
        files,bytes,transportFormat:REMOTE_FORMAT,verification:'sha256-readback',independence:'operator-declared',crossHostRestoreVerified:false};
}

function safeRemoteManifest(raw,expectedHash){
    if(digest(raw)!==expectedHash){throw new Error('SHA256 внешней описи не совпадает с сохранённой квитанцией');}
    const manifest=validateManifest(JSON.parse(raw));
    if(manifest.format!=='neurocenter-recovery-v2'){throw new Error('Нужен recovery-v2 комплект');}
    const directories=new Set(manifest.entries.filter(item=>item.type==='directory').map(item=>item.path));
    for(const entry of manifest.entries){
        let parent=path.posix.dirname(entry.path);
        while(parent!=='.'){if(!directories.has(parent)){throw new Error('В описи отсутствует родительский каталог');}parent=path.posix.dirname(parent);}
    }
    return manifest;
}

async function absent(filename){
    try{await lstat(filename);}catch(error){if(error.code==='ENOENT'){return;}throw error;}
    throw new Error('Целевой каталог уже существует; выберите новое имя');
}

/** Скачивает полный комплект в новый закрытый каталог, затем проверяет его штатным verifier. */
export async function downloadExternalBackup({destination,expectedHash,backupId,config=externalBackupConfiguration(),store=createExternalS3Store(config)}){
    validateInput({backupId,expectedHash});
    if(!destination){throw new Error('Нужен новый каталог назначения');}
    const parent=await realpath(path.dirname(path.resolve(destination)));const info=await lstat(parent);
    if(!info.isDirectory()||info.mode&0o077){throw new Error('Родитель назначения должен иметь права 700');}
    destination=path.join(parent,path.basename(path.resolve(destination)));await absent(destination);
    const raw=await store.get(manifestKey(backupId),MANIFEST_LIMIT);const manifest=safeRemoteManifest(raw,expectedHash);
    const temporary=await mkdtemp(path.join(parent,'.neurocenter-external-'));
    try{
        const directories=manifest.entries.filter(entry=>entry.type==='directory').sort((a,b)=>a.path.split('/').length-b.path.split('/').length);
        for(const entry of directories){await mkdir(path.join(temporary,entry.path),{mode:0o700});}
        for(const entry of manifest.entries.filter(item=>item.type==='file')){
            const handle=await open(path.join(temporary,entry.path),'wx',0o600);const full=createHash('sha256');
            try{
                for(let offset=0,index=0;offset<entry.size;offset+=EXTERNAL_CHUNK_BYTES,index++){
                    const size=Math.min(EXTERNAL_CHUNK_BYTES,entry.size-offset);const chunk=await store.get(objectKey(backupId,entry,index),size);
                    if(chunk.length!==size){throw new Error('Внешний блок усечён');}full.update(chunk);await handle.writeFile(chunk);
                }
                if(full.digest('hex')!==entry.sha256){throw new Error('SHA256 скачанного файла не совпадает с описью');}
                await handle.chmod(entry.mode);await handle.sync();
            }finally{await handle.close();}
        }
        for(const entry of directories.reverse()){await chmod(path.join(temporary,entry.path),entry.mode);}
        await open(path.join(temporary,'manifest.json'),'wx',0o600).then(async handle=>{try{await handle.writeFile(raw);await handle.sync();}finally{await handle.close();}});
        await verifyBackup(temporary,expectedHash);
        // Синхронизируем вложенные имена и права до публикации корня и квитанции.
        for(const directoryPath of [...directories.map(entry=>path.join(temporary,entry.path)),temporary]){
            const handle=await open(directoryPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
            try{await handle.sync();}finally{await handle.close();}
        }
        await absent(destination);await rename(temporary,destination);
        const directory=await open(parent,'r');try{await directory.sync();}finally{await directory.close();}
        return {ok:true,backupId,destination,manifestSha256:expectedHash,verifiedAt:new Date().toISOString(),crossHostRestoreVerified:false};
    }finally{await rm(temporary,{recursive:true,force:true});}
}

async function main(){
    process.umask(0o077);const args=process.argv.slice(2),mode=args.shift(),values={};
    const options={'--source':'source','--destination':'destination','--backup-id':'backupId','--expect-sha256':'expectedHash'};
    for(let index=0;index<args.length;index+=2){const key=options[args[index]];if(!key||!args[index+1]||args[index+1].startsWith('--')||values[key]!==undefined){throw new Error('Неизвестный или незаполненный параметр внешней копии');}values[key]=args[index+1];}
    const action=mode==='upload'?uploadExternalBackup:mode==='download'?downloadExternalBackup:null;
    if(!action){throw new Error('Команды: upload --source <recovery-v2> | download --destination <новый каталог>; обязательны --backup-id и --expect-sha256');}
    console.log(JSON.stringify(await action(values)));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    main().catch(error=>{console.error(error instanceof StorageError?error.message:'Внешняя копия не подтверждена: '+error.message);process.exitCode=1;});
}
