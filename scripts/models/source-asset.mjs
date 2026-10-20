import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import {validateAsset,downloadArtifacts} from '@neurocenter/asset-contract';
import {validateModelBundle} from './bundle-manifest.mjs';

/** Единственная входная опись — source envelope; старые bundle/registry JSON не принимаются. */
export async function readModelAsset(filename) {
    const file=await open(path.resolve(filename),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
        const before=await file.stat();
        if(!before.isFile()||before.nlink!==1||before.size<1||before.size>1024*1024)throw new Error('Нужен обычный asset.json до 1 МиБ.');
        const bytes=await file.readFile(),after=await file.stat();
        if(bytes.length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('asset.json изменился во время чтения.');
        const asset=validateAsset(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
        if(asset.kind!=='model'||asset.delivery.type!=='model-bundle')throw new Error('Для локальных весов нужен model asset с delivery model-bundle.');
        validateModelBundle(asset.delivery.bundle,[asset.delivery.lock]);
        return asset;
    } finally {await file.close();}
}

/** SHA manifest задаёт отдельный тег; установка версии не переключает соседние версии. */
export function modelAssetRuntime(asset) {
    const original=asset.delivery.lock,lock={...original,model:`neurocenter/${original.manifestSha256}:v1`};
    const bundle=structuredClone(asset.delivery.bundle);
    const [name,tag]=lock.model.split(':');
    for(const file of bundle.files)if(file.inlineBase64!==undefined)file.path=`models/manifests/registry.ollama.ai/${name}/${tag}`;
    validateModelBundle(bundle,[lock]);
    return {lock,bundle};
}

/** Операторская подготовка читает только проверяемый SHA-кэш; сетевого обхода каталога нет. */
export function cachedModelTransport(asset,directory) {
    const allowed=new Map(downloadArtifacts(asset).map(item=>[item.url,item]));
    return async url=>{
        const item=allowed.get(String(url));
        if(!item)throw new Error('Модель запросила файл вне собственного source envelope.');
        const filename=path.join(path.resolve(directory),item.sha256+'.blob');
        let file;
        try {file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
        catch(error){if(error.code==='ENOENT')throw new Error('Проверенная часть отсутствует в кэше. Импортируйте ассет или выполните assets:sync для его ID.');throw error;}
        const info=await file.stat();
        if(!info.isFile()||info.nlink!==1||info.size!==item.bytes){await file.close();throw new Error('Тип или размер части модели в SHA-кэше не совпал.');}
        // Native engine потоково проверяет SHA частей и собранных файлов перед активацией.
        return new Response(Readable.toWeb(file.createReadStream({autoClose:true})),{headers:{'content-length':String(info.size)}});
    };
}
