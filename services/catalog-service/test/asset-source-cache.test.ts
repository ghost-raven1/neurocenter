import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assetDigest} from '@neurocenter/asset-contract';
import {assetSourceMode,SourceMetadataCache} from '../src/asset-sources/source-cache';

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
