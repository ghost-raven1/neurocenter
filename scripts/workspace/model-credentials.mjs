import {constants} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {open,writeFile,link,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {safeDirectory} from '../models/bundle-files.mjs';

const invalid=()=>new Error('Ключ шифрования моделей недоступен или изменён. Восстановите сохранённый model_credential_key; автоматическая замена запрещена.');
const publishing=()=>Object.assign(invalid(),{code:'MODEL_KEY_PUBLICATION_BUSY'});
async function readOnce(filename){
    let handle;
    try{
        handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const before=await handle.stat();if(before.isFile()&&before.nlink===2)throw publishing();
        if(!before.isFile()||before.nlink!==1||before.size>128||before.mode&0o077)throw invalid();
        const bytes=await handle.readFile(),after=await handle.stat(),named=await lstat(filename);
        if(after.nlink===2||named.nlink===2)throw publishing();
        if(before.ino!==named.ino||before.dev!==named.dev||named.nlink!==1||!named.isFile()||after.nlink!==1||after.mode&0o077||named.mode&0o077||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw invalid();
        return bytes.toString('utf8');
    }catch(error){if(error.code==='ENOENT')return;if(error.code==='MODEL_KEY_PUBLICATION_BUSY')throw error;throw invalid();}finally{await handle?.close();}
}
async function read(filename){
    for(let attempt=0;;attempt++){
        try{return await readOnce(filename);}catch(error){
            // Atomic link создаёт краткий nlink=2 до удаления собственного temp; постоянный hardlink не принимается.
            if(error.code!=='MODEL_KEY_PUBLICATION_BUSY'||attempt>=40)throw invalid();
            await setTimeout(25);
        }
    }
}

function identity(value){
    const key=value?.replace(/\n$/,'');
    if(!key||!/^[A-Za-z0-9+/]{43}=$/.test(key)||Buffer.from(key,'base64').length!==32||Buffer.from(key,'base64').toString('base64')!==key)throw invalid();
    return createHash('sha256').update('neurocenter:model-credential:v1\0').update(Buffer.from(key,'base64')).digest('hex').slice(0,24);
}

/** Read-only проверка для preflight/DR: наружу выходит только публичная identity, не ключ. */
export async function modelCredentialIdentity(directory,{allowMissing=false}={}){
    try{await safeDirectory(directory);if((await lstat(directory)).mode&0o077)throw invalid();}catch{throw invalid();}
    try{await safeDirectory(directory,'secrets');}catch(error){if(error.code==='ENOENT'&&allowMissing)return;throw invalid();}
    for(const folder of [directory,path.join(directory,'secrets')])if((await lstat(folder)).mode&0o077)throw invalid();
    const filename=path.join(directory,'secrets/model_credential_key'),value=await read(filename),marker=await read(filename+'.id');
    if(value===undefined){if(marker!==undefined||!allowMissing)throw invalid();return;}
    const keyId=identity(value);if(marker!==undefined&&marker!==keyId+'\n')throw invalid();
    return {filename,keyId,markerPresent:marker!==undefined};
}
async function create(filename,value){
    const temporary=filename+'.'+randomBytes(8).toString('hex')+'.tmp';
    try{
        await writeFile(temporary,value,{flag:'wx',mode:0o600,flush:true});
        try{await link(temporary,filename);}catch(error){if(error.code!=='EEXIST')throw error;}
    }finally{await rm(temporary,{force:true});}
    const directory=await open(path.dirname(filename),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{await directory.sync();}finally{await directory.close();}
}

/** Один постоянный серверный ключ; потеря/подмена ранее созданного ключа не вызывает скрытую ротацию. */
export async function ensureModelCredentialKey(directory){
    await safeDirectory(directory,'secrets',true);
    for(const folder of [directory,path.join(directory,'secrets')])if((await lstat(folder)).mode&0o077)throw invalid();
    const filename=path.join(directory,'secrets/model_credential_key'),marker=filename+'.id';
    let value=await read(filename);const previous=await read(marker);
    if(value===undefined){
        if(previous!==undefined)throw invalid();
        await create(filename,randomBytes(32).toString('base64')+'\n');value=await read(filename);
    }
    const keyId=identity(value),expected=keyId+'\n';
    if(previous!==undefined&&previous!==expected)throw invalid();
    await create(marker,expected);if(await read(marker)!==expected||await read(filename)!==value)throw invalid();
    return filename;
}

/** Read-only identity includes explicit operator settings; it never creates or rotates a key. */
export async function modelCredentialEnvironmentIdentity(root,environment=process.env){
    const raw=environment.NEUROCENTER_MODEL_CREDENTIAL_KEY,file=environment.NEUROCENTER_MODEL_CREDENTIAL_KEY_FILE;
    if(raw!==undefined&&file!==undefined)throw invalid();
    if(raw!==undefined){if(typeof raw!=='string'||raw.includes('\n'))throw invalid();return {keyId:identity(raw)};}
    if(file!==undefined){if(typeof file!=='string'||!file)throw invalid();const filename=path.resolve(root,file);return {keyId:identity(await read(filename)),filename};}
    let directory;
    try{directory=await safeDirectory(root,'.run/model-credentials');}catch(error){if(error.code==='ENOENT')return;throw error;}
    return modelCredentialIdentity(directory,{allowMissing:true});
}

/** Явная настройка оператора имеет приоритет; dev автоматически готовит закрытый постоянный ключ. */
export async function modelCredentialEnvironment(root,environment=process.env){
    if(environment.NEUROCENTER_MODEL_CREDENTIAL_KEY!==undefined||environment.NEUROCENTER_MODEL_CREDENTIAL_KEY_FILE!==undefined){await modelCredentialEnvironmentIdentity(root,environment);return {};}
    const directory=await safeDirectory(root,'.run/model-credentials',true);
    return {NEUROCENTER_MODEL_CREDENTIAL_KEY_FILE:await ensureModelCredentialKey(directory)};
}
