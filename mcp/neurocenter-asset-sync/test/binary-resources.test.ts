import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { install } from '../src/bridge/installer.js';
import { uninstall } from '../src/bridge/uninstaller.js';
import { verify, canonical, canonicalV4 } from '../src/bridge/package.js';
import { assetBase, receiptPath } from '../src/bridge/installation-receipt.js';
import { hash, stateDir } from '../src/bridge/state.js';
import { withProjectFiles } from '../src/bridge/installation-files.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';

describe('Бинарные ресурсы полного пакета скилла', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const bytes = Buffer.from([0, 255, 128, 13, 10, 195]);
    const pkg = (version = 1) => {
        const result = packageFixture('skill', version);
        result.schemaVersion = 3;
        result.files.push({path:'assets/пример.bin',content:bytes.toString('base64'),encoding:'base64',size:bytes.length,sha256:hash(bytes)});
        result.manifest.filesCount = result.files.length;
        result.manifest.sha256 = hash(JSON.stringify(canonical({schemaVersion:3,plugin:result.plugin,config:result.config,
            files:result.files.map(({path,size,sha256,encoding})=>({path,size,sha256,...(encoding?{encoding}:{})})).sort((a,b)=>a.path.localeCompare(b.path))})));
        return result;
    };
    const textPkg = (version: number, content = 'Текст вместо бинарного файла') => {
        const result = pkg(version); result.schemaVersion = 2;
        result.files[1] = {path:result.files[1].path, content, size:Buffer.byteLength(content), sha256:hash(content)};
        result.manifest.sha256 = hash(JSON.stringify(canonical({schemaVersion:2,plugin:result.plugin,config:result.config,
            files:result.files.map(({path,size,sha256})=>({path,size,sha256})).sort((a,b)=>a.path.localeCompare(b.path))})));
        return result;
    };
    beforeEach(async () => { fixture = await workspaceFixture(); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary,{recursive:true,force:true}); });
    it('Устанавливает исходные байты, повторяет и удаляет без потерь в резервной копии', async () => {
        const bundle = pkg(); verify(bundle);
        const result = await install('test-project',bundle,async()=>{},async()=>{});
        const file = path.join(fixture.root,assetBase(bundle),'assets/пример.bin');
        expect(await fs.readFile(file)).toEqual(bytes);
        await install('test-project',bundle,async()=>{},async()=>{});
        const removed = await uninstall('test-project',bundle,async()=>{},async()=>{});
        expect(await fs.stat(file).catch(()=>null)).toBeNull();
        const backup = JSON.parse(await fs.readFile(removed.recoveryPath,'utf8'));
        const change = backup.changes.find((item:{relative:string})=>item.relative.endsWith('.bin'));
        expect(Buffer.from(change.before,'base64')).toEqual(bytes); expect(change.encoding).toBe('base64');
        expect(result.manifest).toBe(bundle.manifest.sha256);
    });
    it('Не перезаписывает ручное изменение бинарного файла', async () => {
        const bundle = pkg(); await install('test-project',bundle,async()=>{},async()=>{});
        const file = path.join(fixture.root,assetBase(bundle),'assets/пример.bin');
        await fs.writeFile(file,Buffer.from([1,2,3]));
        await expect(install('test-project',pkg(2),async()=>{},async()=>{})).rejects.toThrow('изменён вручную');
        await expect(uninstall('test-project',bundle,async()=>{},async()=>{})).rejects.toThrow('изменён вручную');
        expect(await fs.readFile(file)).toEqual(Buffer.from([1,2,3]));
    });
    it('Восстанавливает бинарные байты из незавершённого журнала', async () => {
        const file = path.join(fixture.root,'asset.bin'); await fs.writeFile(file,bytes);
        const directory=path.join(stateDir(),'file-changes',hash(fixture.root));await fs.mkdir(directory,{recursive:true});
        const previous=Buffer.from([128,255,0]);
        await fs.writeFile(path.join(directory,'pending.json'),JSON.stringify({version:1,root:fixture.root,id:randomUUID(),state:'prepared',action:'install',assetKey:'1'.repeat(24),manifest:'2'.repeat(64),changes:[{relative:'asset.bin',before:previous.toString('base64'),after:bytes.toString('base64'),encoding:'base64'}]}));
        await withProjectFiles('test-project',async()=>{});
        expect(await fs.readFile(file)).toEqual(previous);
    });
    it('Формат 2 не допускает бинарные файлы; подмена кодирования нарушает манифест', () => {
        const bundle=pkg();bundle.schemaVersion=2;expect(()=>verify(bundle)).toThrow('кодирование');
        const altered=pkg();delete altered.files[1].encoding;expect(()=>verify(altered)).toThrow();
    });
    it('Отклоняет неканонический base64 до записи', () => {
        const bundle=pkg();bundle.files[1].content='AA';expect(()=>verify(bundle)).toThrow('Повреждён');
    });
    it('Меняет кодирование ресурса в обе стороны без потери исходных байтов', async () => {
        await install('test-project',textPkg(1),async()=>{},async()=>{});
        await install('test-project',pkg(2),async()=>{},async()=>{});
        const file=path.join(fixture.root,assetBase(pkg()),'assets/пример.bin');expect(await fs.readFile(file)).toEqual(bytes);
        await install('test-project',textPkg(3),async()=>{},async()=>{});
        expect(await fs.readFile(file,'utf8')).toBe(textPkg(3).files[1].content);
    });
    it('Ошибка после замены бинарного ресурса текстом восстанавливает исходные байты', async () => {
        const initial=pkg(1);await install('test-project',initial,async()=>{},async()=>{});
        const rename=fs.rename.bind(fs);let failed=false;
        vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{
            if(String(to)===path.join(fixture.root,receiptPath(initial))&&!failed){failed=true;throw Object.assign(new Error('Нет места'),{code:'ENOSPC'});}
            return rename(from,to);
        });
        await expect(install('test-project',textPkg(2),async()=>{},async()=>{})).rejects.toThrow('Нет места');
        expect(await fs.readFile(path.join(fixture.root,assetBase(initial),'assets/пример.bin'))).toEqual(bytes);
        expect(JSON.parse(await fs.readFile(path.join(fixture.root,receiptPath(initial)),'utf8')).version).toBe(1);
    });
    it('Недопустимые UTF-8-байты не маскируются под прежний символ замены', async () => {
        const initial=textPkg(1,'\uFFFD');await install('test-project',initial,async()=>{},async()=>{});
        const file=path.join(fixture.root,assetBase(initial),'assets/пример.bin');await fs.writeFile(file,Buffer.from([255]));
        await expect(install('test-project',textPkg(2),async()=>{},async()=>{})).rejects.toThrow('изменён вручную');
        await expect(uninstall('test-project',initial,async()=>{},async()=>{})).rejects.toThrow('изменён вручную');
        expect(await fs.readFile(file)).toEqual(Buffer.from([255]));
    });
    it('Формат 4 проверяется независимо от локали, прежний формат 3 остаётся поддержан',()=>{
        const legacy=pkg();verify(legacy);
        const current=pkg();current.schemaVersion=4;
        current.files.push({path:'assets/z.txt',content:'z',size:1,sha256:hash('z')});current.manifest.filesCount=current.files.length;
        current.manifest.sha256=hash(JSON.stringify(canonicalV4({schemaVersion:4,plugin:current.plugin,config:current.config,
            files:current.files.map(({path,size,sha256,encoding})=>({path,size,sha256,...(encoding?{encoding}:{})})).sort((a,b)=>a.path===b.path?0:a.path<b.path?-1:1)})));
        const locale=vi.spyOn(String.prototype,'localeCompare').mockImplementation(()=>{throw new Error('Зависимость от локали');});
        try{expect(()=>verify(current)).not.toThrow();}finally{locale.mockRestore();}
    });
});
