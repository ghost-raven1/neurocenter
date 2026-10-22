import {createHash, randomUUID, X509Certificate} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, realpath, rm} from 'node:fs/promises';
import path from 'node:path';

const limit=1024*1024;
const contexts=['docker/build-ca','frontend/docker/build-ca'];
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
        return blocks.map(([block])=>{
            let certificate;try{certificate=new X509Certificate(block);}catch{throw new Error('Некорректный PEM-сертификат CA.');}
            if(!certificate.ca){throw new Error('В файле CA найден сертификат, не являющийся центром сертификации.');}
            return certificate.toString()+'\n';
        }).join('');
    }finally{await handle.close();}
}

/** Cleanup recognizes only its own regular inode and complete bytes or a partial write prefix. */
async function cleanup(record,expected){
    let handle;try{handle=await open(record.filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
    catch(error){if(['ENOENT','ELOOP'].includes(error.code))return;throw error;}
    try{
        const before=await handle.stat();if(!before.isFile()||before.nlink!==1||!sameFile(before,record)||before.size>expected.length)return;
        const buffer=Buffer.alloc(expected.length+1);let offset=0;
        while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
        const after=await handle.stat(),named=await lstat(record.filename).catch(error=>{if(error.code==='ENOENT')return;throw error;});
        if(named?.isFile()&&!named.isSymbolicLink()&&named.nlink===1&&sameFile(before,named)&&sameFile(before,after)&&after.nlink===1
            &&after.size===before.size&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs&&offset===before.size
            &&(!record.complete||offset===expected.length)&&buffer.subarray(0,offset).equals(expected.subarray(0,offset)))await rm(record.filename);
    }finally{await handle.close();}
}

/** Each invocation supplies one uniquely named public CA; old artifacts and legacy locks are never touched. */
export async function withDockerBuildCa(root,source,action){
    const environment={...source,NEUROCENTER_BUILD_CA_SHA256:'',NEUROCENTER_BUILD_CA_NAME:'.gitkeep'};
    const selected=source.NEUROCENTER_BUILD_CA_FILE??source.NODE_EXTRA_CA_CERTS;
    if(selected===undefined||selected===''){return action({environment,args:[]});}
    if(typeof selected!=='string'||!selected.trim()||/[\x00-\x1f\x7f]/.test(selected)){throw new Error('Задайте путь к публичному PEM-файлу в NEUROCENTER_BUILD_CA_FILE.');}
    let certificates;
    try{certificates=await readCertificates(path.resolve(root,selected));}
    catch(error){throw new Error('Не удалось подготовить CA для Docker: '+error.message,{cause:error});}
    const bytes=Buffer.from(certificates),name='ca-'+randomUUID()+'.pem',sha=createHash('sha256').update(bytes).digest('hex'),staged=[];
    root=await realpath(root);let failure;
    try{
        for(const context of contexts){
            let directory=root;
            for(const segment of context.split('/')){directory=path.join(directory,segment);const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Каталог CA для Docker не должен быть ссылкой.');}
            const filename=path.join(directory,name),handle=await open(filename,'wx',0o600);
            try{const record={filename,...await handle.stat(),complete:false};staged.push(record);await handle.writeFile(bytes);record.complete=true;}finally{await handle.close();}
        }
        environment.NEUROCENTER_BUILD_CA_SHA256=sha;environment.NEUROCENTER_BUILD_CA_NAME=name;
        return await action({environment,args:['--build-arg','NEUROCENTER_BUILD_CA_SHA256='+sha,'--build-arg','NEUROCENTER_BUILD_CA_NAME='+name]});
    }catch(error){failure=error;throw error;
    }finally{
        let cleanupError;
        for(const record of staged)try{await cleanup(record,bytes);}catch(error){cleanupError??=Object.assign(Error('Не удалось удалить собственный CA-файл: '+record.filename,{cause:error}),{filename:record.filename});}
        if(cleanupError){if(!failure)throw cleanupError;if(failure instanceof Error){failure.cleanupError=cleanupError;failure.message+='\nОчистка CA не завершена: '+cleanupError.message;}}
    }
}
