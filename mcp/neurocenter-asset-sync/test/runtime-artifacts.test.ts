import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { artifactFixture } from '../../../scripts/test/runtime-artifact-fixture.cjs';
import { ensureRuntimeArtifact, resolvePreparedRuntimeArtifact } from '../src/features/runtime-artifacts/cache.js';
import { inspectRuntimeArchive, normalizeRuntimeArtifacts, runtimeArtifactTarget } from '../src/features/runtime-artifacts/model.js';
import { canonicalV4, verify, type Package } from '../src/bridge/package.js';
import { hash, stateDir } from '../src/bridge/state.js';
import { install } from '../src/bridge/installer.js';
import { inspectInstallation } from '../src/bridge/installation-inspection.js';
import { workspaceFixture } from './bridge-fixture.js';
import { receiptPath } from '../src/bridge/installation-receipt.js';

const folders: string[] = [];
async function fixture() { const item = await workspaceFixture(); folders.push(item.temporary); return item; }
const pkgFor = (descriptor: ReturnType<typeof artifactFixture>['descriptor']): Package => {
    const pkg: Package = { schemaVersion: 5, plugin: {id:'ai-plug-runtime',name:'runtime',kind:'mcp',version:1}, config:{transport:'local',extra:{runtimeArtifacts:[descriptor]}}, files:[], manifest:{sha256:'',filesCount:0} };
    pkg.manifest.sha256 = hash(JSON.stringify(canonicalV4({schemaVersion:pkg.schemaVersion,plugin:pkg.plugin,config:pkg.config,files:[]}))); return pkg;
};
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const folder of folders.splice(0)) {await fs.rm(folder,{recursive:true,force:true});} });

describe('Готовые платформенные комплекты без установки зависимостей', () => {
    it('Устанавливает настоящий архив в закрытый кэш и подключает MCP без npm и исполнения', async () => {
        const f = await fixture(); const {archive,descriptor} = artifactFixture(undefined,runtimeArtifactTarget()); const pkg = pkgFor(descriptor); verify(pkg);
        const download = vi.fn(async () => Readable.from([archive])); const prepared = await ensureRuntimeArtifact(pkg,{download});
        expect(prepared?.sha256).toBe(descriptor.sha256); expect(await fs.readFile(prepared!.entrypoint,'utf8')).toBe('export default {};');
        await install('test-project',pkg,async()=>undefined,async()=>undefined);
        const receipt = JSON.parse(await fs.readFile(path.join(f.root,receiptPath(pkg)),'utf8'));
        expect(receipt.config.value.command).toEqual([process.execPath,prepared!.entrypoint]); expect(receipt.files).toEqual({});
        expect((await inspectInstallation('test-project',pkg)).status).toBe('synced');
        await ensureRuntimeArtifact(pkg,{download}); expect(download).toHaveBeenCalledTimes(1);
    });
    it('Хэш формата 5 закрепляет платформу, размер и SHA артефакта', () => {
        const {descriptor} = artifactFixture(); const pkg = pkgFor(descriptor); verify(pkg); pkg.config!.extra!.runtimeArtifacts![0]!.sha256 = '0'.repeat(64); expect(()=>verify(pkg)).toThrow(/манифеста/);
        for (const schemaVersion of [2,3,4]) {expect(()=>verify({...pkgFor(descriptor),schemaVersion})).toThrow(/формат/);}
        expect(()=>normalizeRuntimeArtifacts([{...descriptor,url:'https://example.org/install.sh'}])).toThrow();
    });
    it('Не выбирает соседнюю архитектуру и не загружает неподдерживаемую платформу', async () => {
        await fixture(); const {descriptor} = artifactFixture(undefined,runtimeArtifactTarget()==='darwin-x64'?'darwin-arm64':'darwin-x64'); const download = vi.fn();
        await expect(ensureRuntimeArtifact(pkgFor(descriptor),{download})).rejects.toThrow(/ОС/); expect(download).not.toHaveBeenCalled();
    });
    it.each(['corrupt','truncated','overflow','disconnect'])('Отклоняет повреждение загрузки: %s, не оставляя неполный комплект', async kind => {
        await fixture(); const {archive,descriptor} = artifactFixture(undefined,runtimeArtifactTarget()); let bytes = Buffer.from(archive);
        if(kind==='corrupt')bytes[0]!^=1;if(kind==='truncated')bytes=bytes.subarray(0,bytes.length-1);if(kind==='overflow')bytes=Buffer.concat([bytes,Buffer.from('лишнее')]);
        const download = async () => kind==='disconnect' ? Readable.from((async function*(){yield archive.subarray(0,5);throw new Error('Связь потеряна');})()) : Readable.from([bytes]);
        await expect(ensureRuntimeArtifact(pkgFor(descriptor),{download})).rejects.toThrow(); expect(await fs.readdir(path.join(stateDir(),'runtime-artifacts'))).toEqual([]);
    });
    it.each(['../outside','/absolute','a\\b','CON.txt','а/../б','a:stream','a.','a\u0001b'])('Запрещает опасный путь %s до публикации кэша', async filename => {
        const f = await fixture(); const {archive,descriptor} = artifactFixture([{path:filename,content:'bad'},{path:'ok.mjs',content:'export default {};'}],runtimeArtifactTarget()); descriptor.entrypoint='ok.mjs';
        const file = path.join(f.temporary,'unsafe.tar.gz');await fs.writeFile(file,archive);await expect(inspectRuntimeArchive(file,descriptor)).rejects.toThrow(/путь/);
    });
    it.each(['1','2','3','6','x','g'])('Не принимает ссылку или специальную запись TAR %s', async type => {
        const f = await fixture(); const {archive,descriptor} = artifactFixture([{path:'unsafe',type,content:'x',link:'../../outside'},{path:'ok.mjs',content:'export default {};'}],runtimeArtifactTarget());descriptor.entrypoint='ok.mjs';
        const file = path.join(f.temporary,'link.tar.gz');await fs.writeFile(file,archive);await expect(inspectRuntimeArchive(file,descriptor)).rejects.toThrow(/записи|Ссылки/);
    });
    it.each([[{path:'a.mjs',content:'a'},{path:'A.mjs',content:'b'}],[{path:'a',content:'a'},{path:'a/b',content:'b'}],[{path:'é.mjs',content:'a'},{path:'é.mjs',content:'b'}]].map(files=>[files]))('Запрещает дубликаты, конфликт файла с папкой и Unicode-псевдонимы', async files => {
        const f = await fixture();const {archive,descriptor}=artifactFixture(files,runtimeArtifactTarget());const file=path.join(f.temporary,'duplicate.tar.gz');await fs.writeFile(file,archive);await expect(inspectRuntimeArchive(file,descriptor)).rejects.toThrow(/конфликт/);
    });
    it('Обнаруживает согласованную подмену файла и локальной описи по одобренному архиву', async () => {
        await fixture();const {archive,descriptor}=artifactFixture(undefined,runtimeArtifactTarget());const pkg=pkgFor(descriptor);const resolution=await ensureRuntimeArtifact(pkg,{download:async()=>Readable.from([archive])});
        await fs.chmod(resolution!.entrypoint,0o600);await fs.writeFile(resolution!.entrypoint,'export default 1;');const indexFile=path.join(resolution!.root,'.neurocenter-runtime-index.json');await fs.chmod(indexFile,0o600);const index=JSON.parse(await fs.readFile(indexFile,'utf8'));index.entries[0].sha256=hash('export default 1;');index.entries[0].size=Buffer.byteLength('export default 1;');await fs.writeFile(indexFile,JSON.stringify(index));
        await expect(resolvePreparedRuntimeArtifact(pkg)).rejects.toThrow(/Опись/);expect((await inspectInstallation('test-project',pkg)).status).toBe('unknown');
    });
    it('Не удаляет прежний комплект при неудачном обновлении', async () => {
        const f=await fixture();const first=artifactFixture(undefined,runtimeArtifactTarget());const pkg=pkgFor(first.descriptor);const old=await ensureRuntimeArtifact(pkg,{download:async()=>Readable.from([first.archive])});await install('test-project',pkg,async()=>undefined,async()=>undefined);const before=await fs.readFile(path.join(f.root,'opencode.json'),'utf8');
        const next=artifactFixture([{path:'server.mjs',content:'новый runtime'}],runtimeArtifactTarget());await expect(ensureRuntimeArtifact(pkgFor(next.descriptor),{download:async()=>Readable.from([next.archive.subarray(0,4)])})).rejects.toThrow();expect(await fs.readFile(old!.entrypoint,'utf8')).toBe('export default {};');expect(await fs.readFile(path.join(f.root,'opencode.json'),'utf8')).toBe(before);
    });
    it('Готовит обновление сверх целевого объёма кэша, сохраняя прежний комплект и установку', async () => {
        const f=await fixture(),first=artifactFixture(undefined,runtimeArtifactTarget()),pkg=pkgFor(first.descriptor);
        const old=await ensureRuntimeArtifact(pkg,{download:async()=>Readable.from([first.archive])});await install('test-project',pkg,async()=>undefined,async()=>undefined);
        const configFile=path.join(f.root,'opencode.json'),receiptFile=path.join(f.root,receiptPath(pkg));
        const configBefore=await fs.readFile(configFile),receiptBefore=await fs.readFile(receiptFile);
        const archiveFile=path.join(old!.root,'.neurocenter-runtime-archive.tar.gz'),indexFile=path.join(old!.root,'.neurocenter-runtime-index.json');
        const archiveBefore=await fs.readFile(archiveFile),indexBefore=await fs.readFile(indexFile);
        const retained=path.join(stateDir(),'runtime-artifacts','старый-комплект'),handle=await fs.open(retained,'wx',0o600);
        try{await handle.writeFile('QA retained bytes');await handle.truncate(2*1024**3+4096);}finally{await handle.close();}
        const retainedBefore=await fs.stat(retained),next=artifactFixture([{path:'runtime/server.mjs',content:'export default 2;'}],runtimeArtifactTarget());
        const download=vi.fn(async()=>Readable.from([next.archive])),prepared=await ensureRuntimeArtifact(pkgFor(next.descriptor),{download});
        expect(await fs.readFile(prepared!.entrypoint,'utf8')).toBe('export default 2;');expect(download).toHaveBeenCalledOnce();
        expect(await fs.readFile(old!.entrypoint,'utf8')).toBe('export default {};');
        expect(await fs.readFile(archiveFile)).toEqual(archiveBefore);expect(await fs.readFile(indexFile)).toEqual(indexBefore);
        expect(await fs.readFile(configFile)).toEqual(configBefore);expect(await fs.readFile(receiptFile)).toEqual(receiptBefore);
        expect(await fs.stat(retained)).toMatchObject({ino:retainedBefore.ino,size:retainedBefore.size,mode:retainedBefore.mode});
        const retainedHandle=await fs.open(retained,'r');try{const bytes=Buffer.alloc(17);await retainedHandle.read(bytes,0,bytes.length,0);expect(bytes.toString()).toBe('QA retained bytes');}finally{await retainedHandle.close();}
        expect((await fs.readdir(path.dirname(retained))).sort()).toEqual([first.descriptor.sha256,next.descriptor.sha256,'старый-комплект'].sort());
    });
    it('Отказывает до загрузки, если физически не хватает даже одного байта резерва',async()=>{
        await fixture();const {archive,descriptor}=artifactFixture(undefined,runtimeArtifactTarget());
        const required=descriptor.compressedBytes+descriptor.unpackedBytes+descriptor.filesCount*400+4096+128*1024**2;
        const statfs=vi.spyOn(fs,'statfs').mockResolvedValue({bavail:BigInt(required-1),bsize:1n} as never),download=vi.fn(async()=>Readable.from([archive]));
        await expect(ensureRuntimeArtifact(pkgFor(descriptor),{download})).rejects.toMatchObject({code:'disk-full'});expect(download).not.toHaveBeenCalled();
        expect(await fs.readdir(path.join(stateDir(),'runtime-artifacts'))).toEqual([]);
        statfs.mockResolvedValue({bavail:BigInt(required),bsize:1n} as never);
        const prepared=await ensureRuntimeArtifact(pkgFor(descriptor),{download});expect(await fs.readFile(prepared!.entrypoint,'utf8')).toBe('export default {};');expect(download).toHaveBeenCalledOnce();
    });
    it.each(['symbolic','hard'])('Мягкий target не разрешает %s ссылку в существующем кэше',async kind=>{
        const f=await fixture(),root=path.join(stateDir(),'runtime-artifacts'),outside=path.join(f.temporary,'retained.txt');
        await fs.mkdir(root,{recursive:true,mode:0o700});await fs.writeFile(outside,'QA retained outside cache');
        if(kind==='symbolic')await fs.symlink(outside,path.join(root,'unsafe'));else await fs.link(outside,path.join(root,'unsafe'));
        const {archive,descriptor}=artifactFixture(undefined,runtimeArtifactTarget()),download=vi.fn(async()=>Readable.from([archive]));
        await expect(ensureRuntimeArtifact(pkgFor(descriptor),{download})).rejects.toThrow(/Ссылки/);expect(download).not.toHaveBeenCalled();
        expect(await fs.readFile(outside,'utf8')).toBe('QA retained outside cache');expect(await fs.readdir(root)).toEqual(['unsafe']);
    });
});

describe('Границы USTAR без тяжёлых выделений памяти',()=>{
    it('Не принимает завершающую единственную нулевую запись и данные после двух нулевых блоков',async()=>{
        const f=await fixture();const original=artifactFixture(undefined,runtimeArtifactTarget());const {gunzipSync,gzipSync}=await import('node:zlib');const raw=gunzipSync(original.archive);
        for(const tar of [raw.subarray(0,raw.length-512),Buffer.concat([raw,raw.subarray(0,512)])]){const bytes=gzipSync(tar);const file=path.join(f.temporary,'trailer.tar.gz');await fs.writeFile(file,bytes);await expect(inspectRuntimeArchive(file,{...original.descriptor,compressedBytes:bytes.length,sha256:hash(bytes)})).rejects.toThrow(/опись|окончания|Опись/);}
    });
    it('Сжатая бомба из нулей ограничивается конечным числом TAR-блоков',async()=>{
        const f=await fixture();const original=artifactFixture(undefined,runtimeArtifactTarget());const {gunzipSync,gzipSync}=await import('node:zlib');const raw=gunzipSync(original.archive);const bytes=gzipSync(Buffer.concat([raw,Buffer.alloc(2048*512)]));const file=path.join(f.temporary,'zero-bomb.tar.gz');await fs.writeFile(file,bytes);await expect(inspectRuntimeArchive(file,{...original.descriptor,compressedBytes:bytes.length,sha256:hash(bytes)})).rejects.toThrow(/окончание/);
    });
    it('Явная папка после дочернего файла разрешена, обычный файл вместо этой папки отвергается',async()=>{
        const f=await fixture();for(const type of ['5','0']){const {archive,descriptor}=artifactFixture([{path:'runtime/server.mjs',content:'export default {};'},{path:'runtime',type,content:''}],runtimeArtifactTarget());const file=path.join(f.temporary,'parent.tar.gz');await fs.writeFile(file,archive);if(type==='5'){expect(await inspectRuntimeArchive(file,descriptor)).toHaveLength(1);}else{await expect(inspectRuntimeArchive(file,descriptor)).rejects.toThrow(/конфликт/);}}
    });
    it('Архив с 20 тысячами файлов проверяется без квадратичного обхода имён',async()=>{
        const f=await fixture();const files=Array.from({length:20000},(_,index)=>({path:'runtime/file-'+String(index).padStart(5,'0')+'.mjs',content:'x'}));const {archive,descriptor}=artifactFixture(files,runtimeArtifactTarget());const file=path.join(f.temporary,'limit.tar.gz');await fs.writeFile(file,archive);expect(await inspectRuntimeArchive(file,descriptor)).toHaveLength(20000);
    });
});

it('После аварии возобновляет установку, убрав только собственный staging завершившегося процесса',async()=>{
    await fixture();const {archive,descriptor}=artifactFixture(undefined,runtimeArtifactTarget());const root=path.join(stateDir(),'runtime-artifacts');const id='11111111-1111-4111-8111-111111111111';const stage=path.join(root,'.'+id+'.partial');await fs.mkdir(stage,{recursive:true,mode:0o700});await fs.writeFile(path.join(stage,'.owner.json'),JSON.stringify({schemaVersion:1,id,pid:2147483647}));await fs.writeFile(path.join(stage,'artifact.tar.gz'),'неполные байты');const resolution=await ensureRuntimeArtifact(pkgFor(descriptor),{download:async()=>Readable.from([archive])});expect(resolution?.sha256).toBe(descriptor.sha256);await expect(fs.access(stage)).rejects.toThrow();
});

it('Два MCP используют разные точки входа одного неизменяемого архива по общему SHA',async()=>{
    await fixture();const {archive,descriptor}=artifactFixture([{path:'a.mjs',content:'export default 1;'},{path:'b.mjs',content:'export default 2;'}],runtimeArtifactTarget());const download=vi.fn(async()=>Readable.from([archive]));const first=await ensureRuntimeArtifact(pkgFor(descriptor),{download});const second=await ensureRuntimeArtifact(pkgFor({...descriptor,entrypoint:'b.mjs'}),{download});expect(second?.root).toBe(first?.root);expect(await fs.readFile(second!.entrypoint,'utf8')).toBe('export default 2;');expect(download).toHaveBeenCalledTimes(1);
});

describe('Определение libc не угадывает неизвестную платформу',()=>{
    it('Берёт подтверждённую glibc из runtime report',()=>{expect(runtimeArtifactTarget('linux','x64',{header:{glibcVersionRuntime:'2.36'},sharedObjects:[]})).toBe('linux-x64-glibc');});
    it.each(['/lib/ld-musl-x86_64.so.1','/lib/libc.musl-aarch64.so.1'])('Подтверждает musl по загруженному объекту %s',file=>{expect(runtimeArtifactTarget('linux','arm64',{header:{},sharedObjects:[file]})).toBe('linux-arm64-musl');});
    it.each([{}, {header:{},sharedObjects:[]},{header:{glibcVersionRuntime:''},sharedObjects:['/lib/libc.so.6']},{header:{glibcVersionRuntime:123},sharedObjects:'ld-musl'}])('Оставляет неизвестную libc неподдерживаемой для готовых комплектов',report=>{expect(runtimeArtifactTarget('linux','x64',report)).toBe('linux-x64-unknown');});
    it('Не подставляет Linux или другую архитектуру для остальных систем',()=>{expect(runtimeArtifactTarget('darwin','arm64',{})).toBe('darwin-arm64');expect(runtimeArtifactTarget('freebsd','x64',{})).toBe('freebsd-x64');expect(runtimeArtifactTarget('linux','ppc64',{header:{glibcVersionRuntime:'2.36'}})).toBe('linux-ppc64-glibc');});
});

describe('Валидация плагина до принятия и установки',()=>{
    const plugin=(entrypoint:string,executable?:boolean)=>{
        const {descriptor}=artifactFixture();const pkg=pkgFor({...descriptor,entrypoint,...(executable!==undefined?{executable}:{})});pkg.plugin.kind='plugin';pkg.manifest.sha256=hash(JSON.stringify(canonicalV4({schemaVersion:pkg.schemaVersion,plugin:pkg.plugin,config:pkg.config,files:[]})));return pkg;
    };
    it.each([{entrypoint:'runtime/plugin.exe',executable:true},{entrypoint:'runtime/plugin.mjs',executable:true},{entrypoint:'runtime/plugin.bin',executable:false},{entrypoint:'runtime/plugin.py'}])('Не принимает нативную или не-JS точку входа $entrypoint',({entrypoint,executable})=>{expect(()=>verify(plugin(entrypoint,executable))).toThrow(/плагину.*\.js.*нативного/);});
    it.each(['runtime/plugin.js','runtime/plugin.mjs','runtime/plugin.cjs'])('Принимает импортируемый JS-модуль %s без выполнения',entrypoint=>{expect(()=>verify(plugin(entrypoint))).not.toThrow();expect(()=>verify(plugin(entrypoint,false))).not.toThrow();});
});
