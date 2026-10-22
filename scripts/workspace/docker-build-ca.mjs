import {createHash, randomUUID, X509Certificate} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, readdir, realpath, rm, rmdir} from 'node:fs/promises';
import path from 'node:path';

const limit=1024*1024;
const contexts=['docker/build-ca','frontend/docker/build-ca'];
const leases=new Map();
const sameFile=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;

/** Only public CA certificates may enter the Docker build contexts. */
async function readCertificates(filename){
    const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
        const info=await handle.stat();
        if(!info.isFile()||info.nlink!==1||info.size>limit){throw new Error('Нужен обычный PEM-файл CA размером до 1 МиБ.');}
        const buffer=Buffer.alloc(limit+1);let offset=0;
        while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead){break;}offset+=bytesRead;}
        if(offset>limit){throw new Error('PEM-файл CA превышает 1 МиБ.');}
        const after=await handle.stat(),named=await lstat(filename);
        if(offset!==info.size||!named.isFile()||named.isSymbolicLink()||named.nlink!==1||
            [after,named].some(current=>current.dev!==info.dev||current.ino!==info.ino||current.size!==info.size||current.mtimeMs!==info.mtimeMs||current.ctimeMs!==info.ctimeMs)){
            throw new Error('PEM-файл CA изменился во время чтения; повторите сборку с неизменяемым файлом.');
        }
        const text=buffer.subarray(0,offset).toString('utf8');
        const blocks=[...text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)];
        if(!blocks.length||blocks.length>256||text.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,'').trim()){
            throw new Error('Файл CA должен содержать только публичные PEM-сертификаты, без ключей и других данных.');
        }
        const certificates=blocks.map(([block])=>{
            let certificate;try{certificate=new X509Certificate(block);}catch{throw new Error('Некорректный PEM-сертификат CA.');}
            if(!certificate.ca){throw new Error('В файле CA найден сертификат, не являющийся центром сертификации.');}
            return certificate.toString()+'\n';
        }).join('');
        return{certificates,text};
    }finally{await handle.close();}
}

/** Existing lease owners are never evicted: a dead or ambiguous owner needs explicit operator review. */
async function takeLease(root,state){
    const parent=path.join(root,'.run');await mkdir(parent,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const parentInfo=await lstat(parent);
    if(!parentInfo.isDirectory()||parentInfo.isSymbolicLink())throw Error('Каталог блокировки сборки CA не должен быть ссылкой.');
    const directory=path.join(parent,'docker-build-ca.lock');
    try{await mkdir(directory,{mode:0o700});}
    catch(error){
        if(error.code!=='EEXIST')throw error;
        const info=await lstat(directory),owners=info.isDirectory()&&!info.isSymbolicLink()?await readdir(directory):[];
        const match=owners.length===1&&/^owner-(\d+)-[a-f0-9-]+\.json$/.exec(owners[0]);
        throw Error('Другая или незавершённая сборка CA удерживает '+directory+(match?' (PID '+match[1]+')':'')+'. Проверьте владельца; удаляйте только эту блокировку после завершения процесса.');
    }
    state.lock={directory,info:await lstat(directory)};
    const filename=path.join(directory,'owner-'+process.pid+'-'+randomUUID()+'.json'),handle=await open(filename,'wx',0o600);
    try{state.lock.owner={filename,info:await handle.stat()};await handle.writeFile(JSON.stringify({pid:process.pid,sha256:state.sha})+'\n');}
    finally{await handle.close();}
}

async function assertLease(state){
    const lock=state.lock;if(!lock)return;
    const current=await lstat(lock.directory).catch(()=>undefined),owner=lock.owner&&await lstat(lock.owner.filename).catch(()=>undefined);
    if(!current?.isDirectory()||current.isSymbolicLink()||!sameFile(current,lock.info)||lock.owner&&(!owner?.isFile()||owner.isSymbolicLink()||!sameFile(owner,lock.owner.info)))throw Error('Владелец блокировки CA изменился: '+lock.directory+'. Файлы оставлены для проверки.');
}

async function stage(root,certificates,state){
    await takeLease(root,state);
    for(const context of contexts){
        let directory=root;
        for(const segment of context.split('/')){
            directory=path.join(directory,segment);const info=await lstat(directory);
            if(!info.isDirectory()||info.isSymbolicLink())throw Error('Каталог CA для Docker не должен быть ссылкой.');
        }
        const filename=path.join(directory,'extra.pem');
        let handle;try{handle=await open(filename,'wx',0o600);}
        catch(error){
            if(error.code!=='EEXIST')throw error;
            let existing;try{existing=await readCertificates(filename);}
            catch(error){throw Error('В build-ca уже есть extra.pem с неподтверждённым CA; файл не изменён.',{cause:error});}
            if(existing.text!==certificates)throw Error('В build-ca уже есть extra.pem с другим CA; файл не изменён.');
            continue;// Verified pre-existing public bytes belong to another builder and remain untouched.
        }
        const record={filename,...await handle.stat(),complete:false};state.staged.push(record);
        try{await handle.writeFile(certificates);record.complete=true;}finally{await handle.close();}
    }
}

async function release(state){
    await assertLease(state);
    // Never remove a staged file replaced by another process.
    for(const record of state.staged){
        const {filename}=record,handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(()=>undefined);
        if(!handle)continue;
        try{
            const info=await handle.stat(),current=await lstat(filename).catch(()=>undefined);
            if(current&&info.isFile()&&info.nlink===1&&sameFile(info,record)&&sameFile(info,current)&&info.size<=limit){
                const bytes=Buffer.alloc(limit+1);let offset=0;
                while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
                const named=await lstat(filename).catch(()=>undefined);
                if(named?.isFile()&&!named.isSymbolicLink()&&named.nlink===1&&sameFile(info,named)&&(!record.complete||createHash('sha256').update(bytes.subarray(0,offset)).digest('hex')===state.sha))await rm(filename);
            }
        }finally{await handle.close();}
    }
    if(state.lock){if(state.lock.owner)await rm(state.lock.owner.filename);await rmdir(state.lock.directory);}
}

/** Stage a verified public CA for legacy and BuildKit builders; never inherit npm configuration. */
export async function withDockerBuildCa(root,source,action){
    const environment={...source,NEUROCENTER_BUILD_CA_SHA256:''};
    const selected=source.NEUROCENTER_BUILD_CA_FILE??source.NODE_EXTRA_CA_CERTS;
    if(selected===undefined||selected===''){return action({environment,args:[]});}
    if(typeof selected!=='string'||!selected.trim()||/[\x00-\x1f\x7f]/.test(selected)){throw new Error('Задайте путь к публичному PEM-файлу в NEUROCENTER_BUILD_CA_FILE.');}
    let certificates;
    try{certificates=(await readCertificates(path.resolve(root,selected))).certificates;}
    catch(error){throw new Error('Не удалось подготовить CA для Docker: '+error.message,{cause:error});}
    const sha=createHash('sha256').update(certificates).digest('hex');
    root=await realpath(root);
    const rootInfo=await lstat(root);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw Error('Нужен обычный корневой каталог сборки.');
    let state=leases.get(root);
    if(state?.closing){await state.closing;return withDockerBuildCa(root,source,action);}
    if(state&&state.sha!==sha)throw Error('В этом процессе уже выполняется сборка с другим CA.');
    if(state)state.users++;
    else{state={sha,users:1,staged:[]};leases.set(root,state);state.ready=stage(root,certificates,state);}
    let failure;
    try{
        await state.ready;
        environment.NEUROCENTER_BUILD_CA_SHA256=sha;
        return await action({environment,args:['--build-arg','NEUROCENTER_BUILD_CA_SHA256='+sha]});
    }catch(error){failure=error;throw error;
    }finally{
        if(--state.users===0){
            state.closing=release(state).finally(()=>{leases.delete(root);});
            try{await state.closing;}catch(error){
                if(!failure)throw error;
                if(failure instanceof Error){failure.cleanupError=error;failure.message+='\nОчистка CA не завершена ('+(state.lock?.directory??root)+'): '+error.message;}
            }
        }
    }
}
