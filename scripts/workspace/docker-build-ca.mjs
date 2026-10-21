import {createHash, X509Certificate} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, rm} from 'node:fs/promises';
import path from 'node:path';

const limit=1024*1024;
const contexts=['docker/build-ca','frontend/docker/build-ca'];

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

/** Stage a verified public CA for legacy and BuildKit builders; never inherit npm configuration. */
export async function withDockerBuildCa(root,source,action){
    const environment={...source,NEUROCENTER_BUILD_CA_SHA256:''};
    const selected=source.NEUROCENTER_BUILD_CA_FILE??source.NODE_EXTRA_CA_CERTS;
    if(selected===undefined||selected===''){return action({environment,args:[]});}
    if(typeof selected!=='string'||!selected.trim()||/[\x00-\x1f\x7f]/.test(selected)){throw new Error('Задайте путь к публичному PEM-файлу в NEUROCENTER_BUILD_CA_FILE.');}
    let certificates;
    try{certificates=await readCertificates(path.resolve(root,selected));}
    catch(error){throw new Error('Не удалось подготовить CA для Docker: '+error.message,{cause:error});}
    const sha=createHash('sha256').update(certificates).digest('hex');
    const staged=[];
    try{
        for(const context of contexts){
            const directory=path.join(root,context);
            for(const parent of [path.dirname(directory),directory]){
                const info=await lstat(parent);
                if(!info.isDirectory()||info.isSymbolicLink()){throw new Error('Каталог CA для Docker не должен быть ссылкой.');}
            }
            const filename=path.join(directory,'extra.pem');
            let handle;try{handle=await open(filename,'wx',0o600);}
            catch(error){if(error.code==='EEXIST'){throw new Error('В build-ca уже есть extra.pem: завершите другую сборку или удалите оставшийся файл прежней сборки.');}throw error;}
            const record={filename,...await handle.stat(),complete:false};staged.push(record);
            try{await handle.writeFile(certificates);record.complete=true;}finally{await handle.close();}
        }
        environment.NEUROCENTER_BUILD_CA_SHA256=sha;
        return await action({environment,args:['--build-arg','NEUROCENTER_BUILD_CA_SHA256='+sha]});
    }finally{
        // Never remove a staged file replaced by another process.
        for(const record of staged){
            const {filename}=record;
            const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(()=>undefined);
            if(!handle){continue;}
            try{
                const info=await handle.stat(),current=await lstat(filename).catch(()=>undefined);
                if(current&&info.isFile()&&info.nlink===1&&info.dev===record.dev&&info.ino===record.ino&&info.dev===current.dev&&info.ino===current.ino&&info.size<=limit){
                    const bytes=Buffer.alloc(limit+1);let offset=0;
                    while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead){break;}offset+=bytesRead;}
                    if(!record.complete||createHash('sha256').update(bytes.subarray(0,offset)).digest('hex')===sha){await rm(filename);}
                }
            }finally{await handle.close();}
        }
    }
}
