import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assetDigest,serializeAsset,type AssetDescriptor,type AssetIndex} from '@neurocenter/asset-contract';
import {assetSourceMode,assetSourceTransport,SourceMetadataCache} from '../src/asset-sources/source-cache';
import {AssetSourceClient} from '../src/asset-sources/source-client';

describe('Readonly metadata локальной поставки',()=>{
    let root:string,cache:SourceMetadataCache;
    const bytes=Buffer.from('{"schemaVersion":1}\n'),sha=assetDigest(bytes);
    beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-offline-source-'));cache=new SourceMetadataCache(root);});
    afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
    it('Читает обычный SHA-файл без изменения байтов и mtime',async()=>{
        const filename=path.join(root,sha+'.json');await fs.writeFile(filename,bytes,{mode:0o400});const before=await fs.stat(filename);
        expect(await cache.read(sha,bytes.length)).toEqual(bytes);
        expect((await fs.stat(filename)).mtimeMs).toBe(before.mtimeMs);expect(await fs.readdir(root)).toEqual([sha+'.json']);
    });
    it('Отсутствующие каталог и файл не создаются reader-ом',async()=>{
        expect(await cache.read(sha,1024)).toBeUndefined();
        expect(await new SourceMetadataCache(path.join(root,'missing')).read(sha,1024)).toBeUndefined();expect(await fs.readdir(root)).toEqual([]);
    });
    it('Ограничивает размер до чтения; не принимает каталог, hardlink и symlink',async()=>{
        const filename=path.join(root,sha+'.json'),outside=path.join(root,'outside');await fs.writeFile(filename,bytes);
        await expect(cache.read(sha,bytes.length-1)).rejects.toMatchObject({status:409});await fs.unlink(filename);
        await fs.mkdir(filename);await expect(cache.read(sha,1024)).rejects.toMatchObject({status:409});await fs.rmdir(filename);
        await fs.writeFile(outside,bytes);await fs.symlink(outside,filename);await expect(cache.read(sha,1024)).rejects.toMatchObject({status:409});await fs.unlink(filename);
        await fs.link(outside,filename);await expect(cache.read(sha,1024)).rejects.toMatchObject({status:409});expect(await fs.readFile(outside)).toEqual(bytes);
    });
    it('Не читает подменённый ссылкой корень и не раскрывает путь в ошибке',async()=>{
        const real=path.join(root,'real'),link=path.join(root,'link');await fs.mkdir(real);await fs.symlink(real,link);
        await expect(new SourceMetadataCache(link).read(sha,1024)).rejects.toThrow('Локальная опись');
        try{await cache.read('../secret',1024);}catch(error){expect(String(error)).not.toContain(root);}
    });
    it('Явный режим допускает только online/offline; опечатка не включает сеть',()=>{
        expect(assetSourceMode({})).toBe('online');expect(assetSourceMode({ASSET_SOURCE_MODE:'offline'})).toBe('offline');
        expect(()=>assetSourceMode({ASSET_SOURCE_MODE:'offine'})).toThrow('online или offline');
    });
});

/** Реальные SHA-файлы CLI и серверный transport; сеть заменена только на границе fetch. */
function sourceFixture(){
    const descriptor:AssetDescriptor={schemaVersion:1,id:'helper',kind:'skill',version:'1.0.0',
        source:{type:'release',repository:'https://github.com/example/skills',tag:'v1.0.0'},license:{spdx:'MIT'},compatibility:{packageFormat:5},
        card:{path:'common',slug:'helper',name:'Помощник',body:'Проверенная инструкция',meta:{description:'Локальная поставка'}},delivery:{type:'inline'}};
    const descriptorPath='assets/helper/1.0.0/asset.json',descriptorBytes=serializeAsset(descriptor);
    const index:AssetIndex={schemaVersion:1,assets:[{id:descriptor.id,kind:descriptor.kind,version:descriptor.version,path:descriptorPath,sha256:assetDigest(descriptorBytes),current:true}]};
    const indexBytes=JSON.stringify(index)+'\n',files=new Map([['index.json',indexBytes],[descriptorPath,descriptorBytes]]);
    const pin={schemaVersion:1 as const,repository:'ghost-raven1/neurocenter-assets',commit:'a'.repeat(40),index:{path:'index.json',sha256:assetDigest(indexBytes)}};
    const request=vi.fn(async(url:string|URL|Request,options?:RequestInit)=>{
        expect(options?.redirect).toBe('error');expect(options?.signal).toBeInstanceOf(AbortSignal);
        const prefix=`https://raw.githubusercontent.com/${pin.repository}/${pin.commit}/`,value=String(url);
        expect(value.startsWith(prefix)).toBe(true);const bytes=files.get(value.slice(prefix.length));
        return new Response(bytes??null,{status:bytes===undefined?404:200});
    });
    return {descriptor,descriptorPath,descriptorBytes,index,indexBytes,files,pin,request};
}

describe('Online/offline transport использует предзагруженные SHA metadata',()=>{
    let root:string,directory:string;
    beforeEach(async()=>{
        root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-online-source-'));directory=path.join(root,'.asset-source-metadata');
        vi.stubEnv('RUNTIME_ARTIFACT_DIR',root);vi.stubEnv('ASSET_SOURCE_MODE','online');
    });
    afterEach(async()=>{vi.unstubAllEnvs();await fs.rm(root,{recursive:true,force:true});});
    async function cached(bytes:string){
        await fs.mkdir(directory,{recursive:true});const filename=path.join(directory,assetDigest(bytes)+'.json');
        await fs.writeFile(filename,bytes,{mode:0o400});return filename;
    }
    it('Полный закреплённый граф с рецептом читается из реальных файлов без доступного GitHub',async()=>{
        const f=sourceFixture(),recipe='Проверенный рецепт\n',dependency={...f.descriptor,id:'dependency',card:{...f.descriptor.card,slug:'dependency'}};
        f.descriptor.recipe={path:'recipes/helper.md',sha256:assetDigest(recipe)};
        f.descriptor.dependencies=[{id:dependency.id,version:dependency.version,sha256:assetDigest(serializeAsset(dependency))}];
        const descriptors=[f.descriptor,dependency],index:AssetIndex={schemaVersion:1,assets:descriptors.map(asset=>({id:asset.id,kind:asset.kind,version:asset.version,path:`assets/${asset.id}/${asset.version}/asset.json`,sha256:assetDigest(serializeAsset(asset)),current:true}))};
        const indexBytes=JSON.stringify(index)+'\n',bytes=[indexBytes,...descriptors.map(serializeAsset),recipe];
        const filenames=await Promise.all(bytes.map(cached)),before=await Promise.all(filenames.map(file=>fs.stat(file)));
        const request=vi.fn(async()=>{throw new Error('Внешний источник недоступен');});
        const client=new AssetSourceClient({...f.pin,index:{...f.pin.index,sha256:assetDigest(indexBytes)}},request,undefined,assetSourceTransport());
        const selected=await client.select(['helper']);expect(selected.assets.map(item=>item.asset.id)).toEqual(['dependency','helper']);
        expect(selected.assets.find(item=>item.asset.id==='helper')?.asset).toEqual(f.descriptor);expect(request).not.toHaveBeenCalled();
        expect(await Promise.all(filenames.map(file=>fs.readFile(file,'utf8')))).toEqual(bytes);
        expect((await Promise.all(filenames.map(file=>fs.stat(file)))).map(stat=>stat.mtimeMs)).toEqual(before.map(stat=>stat.mtimeMs));
        expect((await fs.readdir(directory)).sort()).toEqual(filenames.map(file=>path.basename(file)).sort());
    });
    it('Online cache miss читает закреплённый источник и не создаёт readonly cache',async()=>{
        const f=sourceFixture(),client=new AssetSourceClient(f.pin,f.request,undefined,assetSourceTransport());
        expect((await client.select(['helper'])).assets[0].asset).toEqual(f.descriptor);expect(f.request).toHaveBeenCalledTimes(2);
        expect(await fs.readdir(root)).toEqual([]);
    });
    it('При локальном индексе online запрашивает только отсутствующую опись и не дописывает кэш',async()=>{
        const f=sourceFixture(),filename=await cached(f.indexBytes);
        expect((await new AssetSourceClient(f.pin,f.request,undefined,assetSourceTransport()).select(['helper'])).assets[0].asset).toEqual(f.descriptor);
        expect(f.request).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/'+f.descriptorPath),expect.any(Object));
        expect(await fs.readdir(directory)).toEqual([path.basename(filename)]);expect(await fs.readFile(filename,'utf8')).toBe(f.indexBytes);
    });
    it('Online не доверяет повреждённому SHA и проверяет SHA сетевого fallback без перезаписи файла',async()=>{
        const f=sourceFixture();await cached(f.indexBytes);await fs.mkdir(directory,{recursive:true});
        const poison=f.descriptorBytes.replace('Проверенная инструкция','Чужая инструкция'),filename=path.join(directory,f.index.assets[0].sha256+'.json');
        await fs.writeFile(filename,poison,{mode:0o400});
        expect((await new AssetSourceClient(f.pin,f.request,undefined,assetSourceTransport()).select(['helper'])).assets[0].asset).toEqual(f.descriptor);
        expect(f.request).toHaveBeenCalledTimes(1);expect(String(f.request.mock.calls[0][0])).toContain('/'+f.descriptorPath);
        f.files.set(f.descriptorPath,poison);
        await expect(new AssetSourceClient(f.pin,f.request,undefined,assetSourceTransport()).select(['helper'])).rejects.toMatchObject({status:409});
        expect(f.request).toHaveBeenCalledTimes(2);expect(await fs.readFile(filename,'utf8')).toBe(poison);
    });
    it('Offline при отсутствующей описи или повреждённом индексе не обращается к сети',async()=>{
        vi.stubEnv('ASSET_SOURCE_MODE','offline');const f=sourceFixture(),filename=await cached(f.indexBytes);
        const client=new AssetSourceClient(f.pin,f.request,undefined,assetSourceTransport());
        await expect(client.select(['helper'])).rejects.toMatchObject({status:409});
        await fs.chmod(filename,0o600);await fs.writeFile(filename,'damaged');
        await expect(client.select(['helper'])).rejects.toMatchObject({status:409});expect(f.request).not.toHaveBeenCalled();
        expect(await fs.readdir(directory)).toEqual([path.basename(filename)]);
    });
    it('Небезопасный cache file запрещает online fallback и не меняет внешний файл',async()=>{
        const f=sourceFixture();await cached(f.indexBytes);const outside=path.join(root,'outside.json');await fs.writeFile(outside,f.descriptorBytes);
        await fs.symlink(outside,path.join(directory,f.index.assets[0].sha256+'.json'));
        await expect(new AssetSourceClient(f.pin,f.request,undefined,assetSourceTransport()).select(['helper'])).rejects.toMatchObject({status:409});
        expect(f.request).not.toHaveBeenCalled();expect(await fs.readFile(outside,'utf8')).toBe(f.descriptorBytes);
    });
});
