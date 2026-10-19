import {createHash} from 'node:crypto';
import {registryModelLocks,modelName} from './model-registry.mjs';

export const MAX_PART_BYTES=1024**3;
const digest=/^[a-f0-9]{64}$/;
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>Object.keys(value).every(key=>keys.includes(key));
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function modelLocks(registry) {
    return registryModelLocks(registry);
}

/** Только файлы закреплённых моделей; пользовательские ключи, скрипты и настройки не входят в поставку. */
export function lockedFiles(locks) {
    const files=new Map();
    for(const lock of locks) {
        if(!record(lock)||!digest.test(lock.manifestSha256)||!modelName.test(lock.model)||/[\x00-\x20\x7f]/.test(lock.model)
            ||!record(lock.manifest)||!Array.isArray(lock.manifest.layers))throw new Error('Некорректный model.lock.json.');
        const [name,tag]=lock.model.split(':'),manifestPath=`models/manifests/registry.ollama.ai/${name.includes('/')?name:'library/'+name}/${tag}`;
        if(files.has(manifestPath))throw new Error('Повторяющийся тег модели в поставке.');
        files.set(manifestPath,{sha256:lock.manifestSha256,manifest:true,model:lock.model});
        for(const item of [lock.manifest.config,...lock.manifest.layers]) {
            if(!record(item)||!/^sha256:[a-f0-9]{64}$/.test(item.digest)||!Number.isSafeInteger(item.size)||item.size<1||item.size>64*1024**3)throw new Error('Некорректный размер или SHA файла model.lock.json.');
            const filename='models/blobs/'+item.digest.replace(':','-');const current=files.get(filename);
            if(current&&current.size!==item.size)throw new Error('Один SHA модели имеет разные размеры.');
            files.set(filename,{sha256:item.digest.slice(7),size:item.size,manifest:false});
        }
    }
    return files;
}

export function releaseBaseUrl(value) {
    if(typeof value!=='string'||!/^(https:\/\/github\.com\/ghost-raven1\/neurocenter\/releases\/download\/)([a-z0-9][a-z0-9._-]{0,127})\/?$/.test(value)
        ||/\/(?:latest|main|master|head)\/?$/i.test(value))throw new Error('Нужен закреплённый GitHub release Нейроцентра.');
    return value.replace(/\/$/,'');
}

/** Опись полностью сверяется с model.lock; дополнительные пути и подмена манифестов запрещены. */
export function validateModelBundle(value,locks) {
    const allowed=lockedFiles(locks);
    if(!record(value)||!exact(value,['schemaVersion','kind','releaseBaseUrl','files'])||value.schemaVersion!==1||value.kind!=='neurocenter-model-bundle'
        ||!Array.isArray(value.files)||value.files.length!==allowed.size)throw new Error('Некорректная опись поставки моделей.');
    releaseBaseUrl(value.releaseBaseUrl);const seen=new Set(),parts=new Map();
    for(const file of value.files) {
        if(!record(file)||!exact(file,['path','size','sha256','parts','inlineBase64'])||typeof file.path!=='string'||seen.has(file.path)
            ||!Number.isSafeInteger(file.size)||file.size<1||!digest.test(file.sha256))throw new Error('Некорректный файл поставки моделей.');
        const expected=allowed.get(file.path);
        if(!expected||expected.sha256!==file.sha256||expected.size!==undefined&&expected.size!==file.size)throw new Error('Файлы поставки отличаются от model.lock.json.');
        seen.add(file.path);
        if(expected.manifest) {
            if(file.parts!==undefined||typeof file.inlineBase64!=='string'||file.size>128*1024||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.inlineBase64))throw new Error('Некорректный манифест модели.');
            const bytes=Buffer.from(file.inlineBase64,'base64');
            if(bytes.length!==file.size||sha256(bytes)!==expected.sha256)throw new Error('SHA манифеста модели не совпал с model.lock.json.');
        } else {
            if(file.inlineBase64!==undefined||!Array.isArray(file.parts)||!file.parts.length||file.parts.length>64)throw new Error('Нужны закреплённые части файла модели.');
            let size=0;
            for(const part of file.parts) {
                if(!record(part)||!exact(part,['name','size','sha256'])||!digest.test(part.sha256)||!Number.isSafeInteger(part.size)||part.size<1||part.size>MAX_PART_BYTES
                    ||part.name!==`model-${file.sha256}-${String(file.parts.indexOf(part)+1).padStart(3,'0')}.bin`||parts.has(part.name))throw new Error('Некорректная или повторяющаяся часть модели.');
                size+=part.size;parts.set(part.name,part);
            }
            if(size!==file.size)throw new Error('Суммарный размер частей модели не совпал.');
        }
    }
    return value;
}

/** Полный протокол готовности выводится из текущей описи, без фиксированного числа моделей или файлов. */
export function modelBundleSummary(manifest,locks) {
    validateModelBundle(manifest,locks);
    return {models:locks.length,files:manifest.files.length,bytes:manifest.files.reduce((sum,file)=>sum+file.size,0)};
}
