import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

export const registryFile=fileURLToPath(new URL('./model-registry.json',import.meta.url));
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const digest=/^[a-f0-9]{64}$/;
export const modelName=/^(?:[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i;

/** В поставку входят только карточки и закреплённые lock-файлы, без адресов runtime и команд. */
export function validateModelRegistry(value) {
    if(!record(value)||value.schemaVersion!==1||Object.keys(value).some(key=>!['schemaVersion','models'].includes(key))
        ||!Array.isArray(value.models)||!value.models.length||value.models.length>128)throw new Error('Некорректный реестр поставки моделей.');
    const ids=new Set(),names=new Set(),models=new Set();
    for(const item of value.models) {
        if(!record(item)||Object.keys(item).some(key=>!['id','name','descriptor','lock'].includes(key))
            ||typeof item.id!=='string'||!/^model-[a-z0-9][a-z0-9-]{0,120}$/.test(item.id)
            ||typeof item.name!=='string'||!item.name.trim()||item.name!==item.name.trim()||item.name.length>128||/[\x00-\x1f\x7f]/.test(item.name)
            ||typeof item.lock!=='string'||!(/^(?:\.\.\/(?:embedding|vision)\/model|\.\/locks\/model-[a-z0-9-]+)\.lock\.json$/.test(item.lock)))throw new Error('Некорректная карточка реестра моделей.');
        const model=item.descriptor;
        if(!record(model)||Object.keys(model).some(key=>!['description','capability','runtime','model','manifestSha256','dimension','source'].includes(key))
            ||typeof model.description!=='string'||model.description.length>4000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(model.description)
            ||!['embedding','vision','chat'].includes(model.capability)||model.runtime!=='ollama'||model.source!=='builtin'
            ||typeof model.model!=='string'||model.model.length>200||!modelName.test(model.model)||/[\x00-\x20\x7f]/.test(model.model)||!digest.test(model.manifestSha256)
            ||!(model.dimension===null||model.capability==='embedding'&&Number.isSafeInteger(model.dimension)&&model.dimension>0&&model.dimension<=16384))throw new Error('Некорректное описание модели в поставке.');
        if(ids.has(item.id)||names.has(item.name.toLocaleLowerCase('en-US'))||models.has(model.model.toLowerCase()))throw new Error('Повторяющаяся модель в реестре поставки.');
        ids.add(item.id);names.add(item.name.toLocaleLowerCase('en-US'));models.add(model.model.toLowerCase());
    }
    return value;
}

export async function readModelRegistry(filename=registryFile) {
    return validateModelRegistry(JSON.parse(await readFile(filename,'utf8')));
}

/** Сохраняет прежние embedding/vision lock-файлы и добавляет произвольное число моделей из реестра. */
export async function registryModelLocks(filename=registryFile) {
    const registry=await readModelRegistry(filename),base=pathToFileURL(path.resolve(filename));
    return Promise.all(registry.models.map(async item=>{
        const lock=JSON.parse(await readFile(new URL(item.lock,base),'utf8'));
        if(lock.model!==item.descriptor.model||lock.manifestSha256!==item.descriptor.manifestSha256)throw new Error('Карточка поставки отличается от model.lock.json.');
        return lock;
    }));
}
