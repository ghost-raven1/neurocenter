import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeArtifacts } from '../src/runtime-artifacts/runtime-artifacts';
import { buildPackage, verifyPackage } from '../src/catalog/bundle-package';
import { inspectRuntimeArchive } from '../../shared/runtime-artifacts.cjs';
import { artifactFixture } from '../../../scripts/test/runtime-artifact-fixture.cjs';
import type { DeviceStore } from '../src/devices/device-store';
import { assertInstallablePackage, installationRef, installationSetHash, verifyInstallationSet } from '../src/devices/installation-set';
import { assertPackageBridge } from '../src/devices/device-compatibility';

const roots: string[] = [];
async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'nc-runtime-artifact-')); roots.push(root); const directory=path.join(root,'volume');vi.stubEnv('RUNTIME_ARTIFACT_DIR',directory);
    const registry = new Map<string,{compressed_bytes:number;unpacked_bytes:number;files_count:number}>();
    const query = vi.fn(async (sql:string,params:unknown[]) => {
        const sha=params[0] as string;
        if(sql.startsWith('INSERT')) {if(!registry.has(sha)){registry.set(sha,{compressed_bytes:params[1] as number,unpacked_bytes:params[2] as number,files_count:params[3] as number});}return {rows:[]};}
        return {rows:registry.has(sha)?[registry.get(sha)]:[]};
    });
    const service = new RuntimeArtifacts({pool:{query}} as unknown as DeviceStore); const archive=artifactFixture();const source=path.join(root,'built.tar.gz');await fs.writeFile(source,archive.archive);
    return {root,directory,source,service,registry,query,...archive};
}
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});

describe('Неизменяемые архивы готовых платформенных комплектов',()=>{
    it('Импортирует настоящий архив и отдаёт точные байты без исполнения содержимого',async()=>{
        const f=await fixture();expect(await f.service.importArchive(f.source,f.descriptor)).toEqual(f.descriptor);
        const opened=await f.service.open(f.descriptor.sha256);const chunks:Buffer[]=[];for await(const chunk of opened.stream)chunks.push(Buffer.from(chunk));expect(Buffer.concat(chunks)).toEqual(f.archive);expect(opened.bytes).toBe(f.archive.length);expect(f.registry.size).toBe(1);
        expect((await fs.stat(path.join(f.directory,f.descriptor.sha256+'.tar.gz'))).mode&0o777).toBe(0o400);
    });
    it('Повторный импорт не перезаписывает inode, mtime и одобренные байты',async()=>{
        const f=await fixture();await f.service.importArchive(f.source,f.descriptor);const target=path.join(f.directory,f.descriptor.sha256+'.tar.gz');const before=await fs.stat(target);
        await f.service.importArchive(f.source,f.descriptor);const after=await fs.stat(target);expect({ino:after.ino,mtime:after.mtimeMs}).toEqual({ino:before.ino,mtime:before.mtimeMs});expect(await fs.readdir(f.directory)).toEqual([f.descriptor.sha256+'.tar.gz']);
    });
    it('Обрезанный архив и неверный SHA не публикуются и не регистрируются',async()=>{
        const f=await fixture();await fs.writeFile(f.source,f.archive.subarray(0,5));await expect(f.service.importArchive(f.source,f.descriptor)).rejects.toThrow();expect(f.registry.size).toBe(0);
        await fs.writeFile(f.source,f.archive);await expect(f.service.importArchive(f.source,{...f.descriptor,sha256:'a'.repeat(64)})).rejects.toThrow(/SHA/);expect(f.registry.size).toBe(0);
    });
    it('Не отдаёт незарегистрированный, изменённый или отсутствующий файл',async()=>{
        const f=await fixture();await expect(f.service.open(f.descriptor.sha256)).rejects.toThrow(/не загружен/);await f.service.importArchive(f.source,f.descriptor);const target=path.join(f.directory,f.descriptor.sha256+'.tar.gz');await fs.chmod(target,0o600);const changed=Buffer.from(f.archive);changed[0]^=1;await fs.writeFile(target,changed);await expect(f.service.open(f.descriptor.sha256)).rejects.toThrow(/изменился/);await fs.unlink(target);await expect(f.service.open(f.descriptor.sha256)).rejects.toThrow(/недоступен/);
    });
    it('Ссылка вместо архива не раскрывает внешний файл',async()=>{
        const f=await fixture();await f.service.importArchive(f.source,f.descriptor);const target=path.join(f.directory,f.descriptor.sha256+'.tar.gz');await fs.unlink(target);await fs.symlink(f.source,target);await expect(f.service.open(f.descriptor.sha256)).rejects.toThrow();
    });
    it('Публикует формат 5 и включает весь descriptor в одобренный SHA',async()=>{
        const f=await fixture();const config={transport:'local',extra:{runtimeArtifacts:[f.descriptor]}};const pkg=buildPackage({id:'ai-plug-a',name:'a',kind:'mcp',version:1},[],new Date().toISOString(),config);expect(pkg.schemaVersion).toBe(5);expect(verifyPackage(pkg)).toBe(true);pkg.config!.extra!.runtimeArtifacts=[{...f.descriptor,sha256:'a'.repeat(64)}];expect(verifyPackage(pkg)).toBe(false);
        expect(()=>assertPackageBridge({capabilities:['package-v4']},pkg)).toThrow(/0.9/);expect(()=>assertPackageBridge({capabilities:['package-v5']},pkg)).not.toThrow();
    });
    it('Одобрение принимает полный граф artifact-only MCP без внешней команды',async()=>{
        const f=await fixture();const dep=buildPackage({id:'ai-plug-dep',name:'dep',kind:'mcp',version:1},[],new Date().toISOString(),{transport:'stdio',extra:{runtimeArtifacts:[f.descriptor]}});const root=buildPackage({id:'ai-plug-root',name:'root',kind:'mcp',version:1},[],new Date().toISOString(),{transport:'stdio',extra:{runtimeArtifacts:[f.descriptor],requirements:{dependencies:[installationRef(dep)]}}});expect(()=>assertInstallablePackage(root)).not.toThrow();const set={schemaVersion:1 as const,root:installationRef(root),packages:[root,dep],manifest:installationSetHash(installationRef(root),[root,dep])};expect(verifyInstallationSet(set)).toBe(true);
    });
    it('Обычный пакет сохраняет формат 4 и прежний контракт',()=>{
        const pkg=buildPackage({id:'ai-plug-a',name:'a',kind:'mcp',version:1},[{path:'server.mjs',content:'export default {};'}],new Date().toISOString(),{command:'node',entrypoint:'server.mjs'});expect(pkg.schemaVersion).toBe(4);expect(verifyPackage(pkg)).toBe(true);
    });
    it('Некорректная опись и ложный размер распаковки блокируются до импорта',async()=>{
        const f=await fixture();await expect(f.service.importArchive(f.source,{...f.descriptor,unpackedBytes:f.descriptor.unpackedBytes+1})).rejects.toThrow(/опись|Опись/);await expect(f.service.importArchive(f.source,{...f.descriptor,compressedBytes:256*1024**2+1})).rejects.toThrow();expect(f.registry.size).toBe(0);
    });
    it('Обнаруживает повреждённый заголовок даже с заново вычисленным SHA сжатого архива',async()=>{
        const f=await fixture();const {gunzipSync,gzipSync}=await import('node:zlib');const {createHash}=await import('node:crypto');const tar=gunzipSync(f.archive);tar[100]^=1;const broken=gzipSync(tar);await fs.writeFile(f.source,broken);await expect(inspectRuntimeArchive(f.source,{...f.descriptor,compressedBytes:broken.length,sha256:createHash('sha256').update(broken).digest('hex')})).rejects.toThrow(/заголовок/);
    });
});

describe('Одобрение плагина проверяет формат точки входа',()=>{
    const plugin=(entrypoint:string,executable?:boolean)=>{
        const {descriptor}=artifactFixture();return buildPackage({id:'ai-plug-runtime-plugin',name:'runtime-plugin',kind:'plugin',version:1},[],'now',{extra:{runtimeArtifacts:[{...descriptor,entrypoint,...(executable!==undefined?{executable}:{})}]}});
    };
    it.each([{entrypoint:'runtime/plugin.exe',executable:true},{entrypoint:'runtime/plugin.mjs',executable:true},{entrypoint:'runtime/plugin.bin',executable:false},{entrypoint:'runtime/plugin.py'}])('Отклоняет нативную или не-JS точку входа $entrypoint до утверждения',({entrypoint,executable})=>{const pkg=plugin(entrypoint,executable);expect(verifyPackage(pkg)).toBe(true);expect(()=>assertInstallablePackage(pkg)).toThrow(/плагину.*\.js.*до одобрения/);});
    it.each(['runtime/plugin.js','runtime/plugin.mjs','runtime/plugin.cjs'])('Одобряет импортируемый JS-модуль %s без install hooks',entrypoint=>{expect(()=>assertInstallablePackage(plugin(entrypoint))).not.toThrow();expect(()=>assertInstallablePackage(plugin(entrypoint,false))).not.toThrow();});
});
