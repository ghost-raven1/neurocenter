import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {Header,Pax} from 'tar';
import {readSourceArchive,SOURCE_ARCHIVE_LIMITS} from '../src/asset-sources/source-archive-reader';
import {ArchiveStager} from '../src/asset-sources/source-archive-reader-files';
import {tar,zip,type FixtureEntry} from './source-archive-reader.fixture';
const capacity=vi.hoisted(()=>({reserve:vi.fn()}));
vi.mock('../../shared/capacity.cjs',async original=>{const actual=await original<typeof import('../../shared/capacity.cjs')>();return {...actual,reserveCapacity:capacity.reserve};});
let root:string,input:string,output:string;
const signal=()=>new AbortController().signal;
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
beforeEach(async()=>{root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-source-reader-')));input=path.join(root,'uploaded.bin');output=path.join(root,'stage');await fs.mkdir(output);capacity.reserve.mockReset().mockResolvedValue(()=>{});});
afterEach(async()=>{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
const read=async(bytes:Buffer,abort=signal())=>{await fs.writeFile(input,bytes);return readSourceArchive(input,output,abort);};
async function rejected(bytes:Buffer,pattern?:RegExp){await expect(read(bytes)).rejects.toThrow(pattern);expect(await fs.readdir(output)).toEqual([]);}
const source:FixtureEntry[]=[{path:'index.json',content:'{"schemaVersion":1,"assets":[]}\n'},{path:'assets/example/1.0.0/asset.json',content:'{"exact":"Привет 日本語"}\n'},{path:'recipes/example/build.json',content:'{"recipe":1}'},{path:'docs/nested/file.md',content:'Normal extra repository source'}];
function paxRecord(key:string,value:Buffer):Buffer{
    const body=Buffer.concat([Buffer.from(' '+key+'='),value,Buffer.from('\n')]);let size=body.length+1;
    while(String(size).length+body.length!==size)size=String(size).length+body.length;
    return Buffer.concat([Buffer.from(String(size)),body]);
}
function tarName(block:Buffer,name:Buffer,length=100):void{
    block.fill(0,0,100);name.copy(block,0,0,length);block.fill(32,148,156);
    let checksum=0;for(const byte of block.subarray(0,512))checksum+=byte;block.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');
}

describe('Streaming repository and offline-cache archives',()=>{
    it.each(['zip','tar','tgz'])('Stages raw %s repository bytes with actual SHA and no wrapper',async format=>{
        const archive=format==='zip'?zip(source):format==='tar'?tar(source):gzipSync(tar(source)),result=await read(archive);
        expect(result.rootName).toBeUndefined();expect([...result.files.keys()]).toEqual(source.map(file=>file.path));
        for(const expected of source){const file=result.files.get(expected.path)!;expect(file.bytes).toBe(Buffer.byteLength(expected.content!));expect(file.sha256).toBe(digest(expected.content!));expect(await fs.readFile(file.path)).toEqual(Buffer.from(expected.content!));expect(path.dirname(file.path).startsWith(output+path.sep)).toBe(true);const info=await fs.lstat(file.path);expect(info.isFile()).toBe(true);expect(info.nlink).toBe(1);}
        expect(capacity.reserve).toHaveBeenCalledTimes(source.length);
    });
    it.each(['zip','tar','tgz'])('Strips one wrapper in %s while safely counting and ignoring macOS metadata',async format=>{
        const files=[{path:'__MACOSX/._repository',content:Buffer.from([0,255])},...source.map(file=>({...file,path:'neurocenter-assets-main/'+file.path})),{path:'neurocenter-assets-main/.DS_Store',content:Buffer.from([0,255])},{path:'neurocenter-assets-main/._.',content:'metadata'}];
        const bytes=format==='zip'?zip(files):format==='tar'?tar(files):gzipSync(tar(files)),result=await read(bytes);
        expect(result.rootName).toBe('neurocenter-assets-main');expect([...result.files.keys()]).toEqual(source.map(file=>file.path));expect(capacity.reserve).toHaveBeenCalledTimes(source.length);
    });
    it.each(['zip','tar','tgz'])('Keeps exact metadata and binary SHA-cache paths in %s',async format=>{
        const payload=Buffer.from([0,255,128,1]),metadata=Buffer.from('{"pinned":true}\n'),files=[{path:'runtime-artifacts/.asset-source-metadata/'+digest(metadata)+'.json',content:metadata},{path:'runtime-artifacts/.asset-source-blobs/'+digest(payload)+'.blob',content:payload}];
        const result=await read(format==='zip'?zip(files):format==='tar'?tar(files):gzipSync(tar(files)));
        expect(result.rootName).toBe('runtime-artifacts');expect([...result.files.keys()]).toEqual(files.map(file=>file.path.slice('runtime-artifacts/'.length)));
        expect(result.files.get('.asset-source-blobs/'+digest(payload)+'.blob')?.sha256).toBe(digest(payload));
    });
    it('ZIP64 and signed data descriptors retain the ordinary contract',async()=>{
        const files=source.map(file=>({...file,zip64:true,descriptor:true})),result=await read(zip(files,true));expect(result.files.size).toBe(source.length);
    });
    it('Stored ZIP files and empty directory records use the standard uncompressed reader',async()=>{
        const files=[{path:'repo/',method:0 as const},{path:'repo/assets/',method:0 as const},...source.map(file=>({...file,path:'repo/'+file.path,method:0 as const}))];
        const result=await read(zip(files));expect(result.rootName).toBe('repo');expect([...result.files.keys()]).toEqual(source.map(file=>file.path));
    });
    it.each(['zip','tar'])('An unwrapped metadata-only %s cache retains its canonical directory',async format=>{
        const metadata=Buffer.from('{"pinned":true}'),name='.asset-source-metadata/'+digest(metadata)+'.json',files=[{path:name,content:metadata}];
        const result=await read(format==='zip'?zip(files):tar(files));expect(result.rootName).toBeUndefined();expect([...result.files.keys()]).toEqual([name]);
    });
    it.each(['zip','tar'])('Preserves literal Unicode BOM filename bytes in %s identities',async format=>{
        const files=[{path:'\uFEFFindex.json',content:'exact'}],result=await read(format==='zip'?zip(files):tar(files));expect([...result.files.keys()]).toEqual(['\uFEFFindex.json']);
    });
    it('Returned staged paths remain absolute when the trusted caller uses relative input paths',async()=>{
        await fs.writeFile(input,zip(source));const result=await readSourceArchive(path.relative(process.cwd(),input),path.relative(process.cwd(),output),signal());
        expect([...result.files.values()].every(file=>path.isAbsolute(file.path))).toBe(true);
    });
    it('TAR accepts a safe root directory, validated PAX paths and GNU long names',async()=>{
        const pax=new Pax({path:'repo/日本語/index.json'}).encode(),gnu=tar([{path:'./',type:'Directory'},{path:'././@LongLink',type:'NextFileHasLongPath',content:'repo/recipes/long/build.json\0'},{path:'placeholder',content:'recipe'}]);
        const bytes=Buffer.concat([pax,tar([{path:'placeholder',content:'index'}]).subarray(0,-1024),gnu]);
        const result=await read(bytes);expect(result.rootName).toBe('repo');expect([...result.files.keys()]).toEqual(['日本語/index.json','recipes/long/build.json']);
    });
    it('Native PAX Unicode truncation and binary xattrs retain only the safe authoritative filename',async()=>{
        const name='./'+'あ'.repeat(70)+'.json',body=tar([{path:'placeholder',content:'exact'}]);tarName(body,Buffer.from(name));
        const attributes=Buffer.concat([paxRecord('path',Buffer.from(name)),paxRecord('SCHILY.xattr.com.apple.provenance',Buffer.from([0,255,128,10,61]))]);
        const metadata=tar([{path:'pax',type:'ExtendedHeader',content:attributes}]).subarray(0,-1024);tarName(metadata,Buffer.from('PaxHeader/._'+'あ'.repeat(70)),99);
        const result=await read(Buffer.concat([metadata,body]));
        expect([...result.files.keys()]).toEqual([name.slice(2)]);expect(await fs.readFile([...result.files.values()][0].path,'utf8')).toBe('exact');
    });
    it('An authoritative PAX full path is not duplicated by the fallback USTAR prefix',async()=>{
        const name='repo/'+'directory-'.repeat(14)+'/index.json',result=await read(Buffer.concat([new Pax({path:name}).encode(),tar([{path:name,content:'exact'}])]));
        expect(result.rootName).toBe('repo');expect([...result.files.keys()]).toEqual([name.slice(5)]);
    });
    it('Streams a 24MiB regular blob with bounded reads and staged bytes, never readFile',async()=>{
        const size=24*1024**2,header=new Header({path:'.asset-source-blobs/blob.blob',type:'File',size});header.encode();
        const file=await fs.open(input,'wx'),chunk=Buffer.alloc(1024**2,23),hash=createHash('sha256');
        try{await file.write(header.block!);for(let index=0;index<24;index++){await file.write(chunk);hash.update(chunk);}await file.write(Buffer.alloc(1024));}finally{await file.close();}
        const spy=vi.spyOn(fs,'readFile').mockRejectedValue(Error('readFile is forbidden'));
        const result=await readSourceArchive(input,output,signal()),entry=[...result.files.values()][0];expect(entry.bytes).toBe(size);expect(entry.sha256).toBe(hash.digest('hex'));expect((await fs.stat(entry.path)).size).toBe(size);expect(spy).not.toHaveBeenCalled();
    });
    it('Capacity is reserved before a file is created and its refusal cleans only this extraction',async()=>{
        const failure=Object.assign(new Error('fixture capacity refusal'),{code:'CAPACITY_LOW'});capacity.reserve.mockRejectedValueOnce(failure);
        const unrelated=path.join(output,'existing');await fs.writeFile(unrelated,'preserve');await expect(read(zip(source))).rejects.toBe(failure);
        expect(await fs.readdir(output)).toEqual(['existing']);expect(await fs.readFile(unrelated,'utf8')).toBe('preserve');
    });
    it('Abort before parsing or during a reservation leaves no staged files',async()=>{
        const controller=new AbortController();controller.abort(Error('cancelled'));await expect(read(zip(source),controller.signal)).rejects.toThrow('cancelled');expect(await fs.readdir(output)).toEqual([]);
        const active=new AbortController();capacity.reserve.mockImplementationOnce(async()=>{active.abort(Error('mid-stream cancellation'));return ()=>{};});
        await expect(read(gzipSync(tar(source)),active.signal)).rejects.toThrow('mid-stream cancellation');expect(await fs.readdir(output)).toEqual([]);
    });
});

describe('Every archive entry is checked before exposing a file map',()=>{
    it.each(['../escape','/absolute','C:/drive','bad\\path','parent/../escape','bad\0path','CON/file','parent /file'])('Rejects unsafe path %s in ZIP and TAR',async name=>{
        await rejected(zip([{path:name,content:'unsafe'}]));await rejected(tar([{path:name,content:'unsafe'}]));
    });
    it.each([['A/file','a/other'],['é/file','e\u0301/other'],['file','file/child'],['file/child','file'],['index.json','index.json']])('Rejects duplicate, alias or parent collision %s / %s',async(first,second)=>{
        for(const bytes of [zip([{path:first,content:'1'},{path:second,content:'2'}]),tar([{path:first,content:'1'},{path:second,content:'2'}])])await rejected(bytes,/конфликт|повтор/);
    });
    it.each(['SymbolicLink','Link','FIFO','CharacterDevice','BlockDevice'])('Rejects TAR %s, including macOS ignored paths',async type=>{
        await rejected(tar([{path:'__MACOSX/link',type:type as Header['type'],link:'../outside'}]),/Ссылки|специальные/);
    });
    it.each([0o120777,0o020644,0o060644,0o010644])('Rejects special UNIX mode %s in ZIP',async mode=>{await rejected(zip([{path:'__MACOSX/link',content:'outside',mode}]),/Ссылки|специальные/);});
    it('Rejects ZIP encryption, invalid CRC, invalid UTF-8 and local/central disagreement',async()=>{
        await rejected(zip([{path:'index.json',content:'index',encrypted:true}]));await rejected(zip([{path:'index.json',content:'index',crc:0}]),/CRC/);
        await rejected(zip([{path:'bad',rawName:Buffer.from([0xff]),content:'index'}]),/UTF-8/);
        const inconsistent=zip([{path:'index.json',content:'index'}]);inconsistent[30]='X'.charCodeAt(0);await rejected(inconsistent,/заголовок/);
    });
    it('Rejects truncated archives, TAR checksum/padding damage and all trailing garbage',async()=>{
        const original=tar(source),checksum=Buffer.from(original);checksum[100]^=1;
        for(const bytes of [zip(source).subarray(0,-10),original.subarray(0,-512),checksum,Buffer.concat([zip(source),Buffer.from('garbage')]),Buffer.concat([original,Buffer.from('garbage')]),Buffer.concat([gzipSync(original),Buffer.from('garbage')]),Buffer.concat([gzipSync(original),Buffer.alloc(4)])])await rejected(bytes);
        const padding=tar([{path:'index.json',content:'x'}]);padding[513]=1;await rejected(padding,/выравнивание/);
    });
    it('Rejects compressed ZIP member junk and corrupt data descriptors',async()=>{
        await rejected(zip([{path:'index.json',content:'x',compressedTail:Buffer.from('junk')}]),/посторонние|повреждён/);
        const bytes=zip([{path:'index.json',content:'x',descriptor:true}]),marker=bytes.indexOf(Buffer.from([0x50,0x4b,0x07,0x08]));bytes[marker+4]^=1;await rejected(bytes,/дескриптор/);
    });
    it('Rejects hidden ZIP gaps, conflicting central offsets and directory payload declarations',async()=>{
        const bytes=zip(source),central=bytes.readUInt32LE(bytes.length-6),gap=Buffer.from('hidden payload');
        const altered=Buffer.concat([bytes.subarray(0,central),gap,bytes.subarray(central)]);altered.writeUInt32LE(central+gap.length,altered.length-6);await rejected(altered,/посторонние/);
        const offsets=zip(source),next=offsets.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]),central+4);offsets.writeUInt32LE(0,next+42);await rejected(offsets);
        await rejected(tar([{path:'directory/',type:'Directory',unpacked:512}]),/Папка/);
        await rejected(Buffer.concat([new Pax({path:'repo/directory/',size:512}).encode(),tar([{path:'directory/',type:'Directory'}])]),/Папка/);
    });
    it('Rejects oversized declarations, too many entries and oversized metadata before payload writes',async()=>{
        await rejected(zip([{path:'huge.blob',content:'x',zip64:true,unpacked:SOURCE_ARCHIVE_LIMITS.expandedBytes+1}]),/лимит/);
        await rejected(tar([{path:'huge.blob',unpacked:SOURCE_ARCHIVE_LIMITS.expandedBytes+1}]),/лимит/);
        await rejected(zip(Array.from({length:SOURCE_ARCHIVE_LIMITS.entries+1},(_,index)=>({path:'dir'+index+'/',method:0 as const}))),/лимит/);
        await rejected(tar([{path:'pax',type:'ExtendedHeader',unpacked:SOURCE_ARCHIVE_LIMITS.extensionBytes+1}]),/64 КиБ/);
        expect(capacity.reserve).not.toHaveBeenCalled();
    });
    it('Bounds deep path parsing and retained identity metadata independently of payload sizes',async()=>{
        await rejected(zip([{path:Array.from({length:SOURCE_ARCHIVE_LIMITS.pathDepth+1},()=> 'p').join('/'),content:'x'}]),/глубокий/);
        const stager=new ArchiveStager(output,signal());let count=0;
        expect(()=>{for(;count<SOURCE_ARCHIVE_LIMITS.entries;count++)stager.add(Array.from({length:32},(_,index)=>String(count)+'-'+index+'-abcdefghijk').join('/'),0,false);}).toThrow('Имена путей');
        expect(count).toBeLessThan(SOURCE_ARCHIVE_LIMITS.entries);expect(await fs.readdir(output)).toEqual([]);expect(capacity.reserve).not.toHaveBeenCalled();
    });
    it('Rejects dangerous, malformed or dangling PAX/GNU metadata',async()=>{
        for(const bytes of [Buffer.concat([new Pax({path:'../escape'}).encode(),tar([{path:'safe',content:'x'}])]),tar([{path:'pax',type:'ExtendedHeader',content:'broken\n'},{path:'safe',content:'x'}]),tar([{path:'pax',type:'ExtendedHeader',content:'12 path=bad\n'}]),tar([{path:'long',type:'NextFileHasLongPath',content:'/absolute\0'},{path:'safe',content:'x'}])])await rejected(bytes);
        await rejected(Buffer.concat([new Pax({path:'repo/safe'}).encode(),tar([{path:'../unsafe',content:'x'}])]),/небезопасный/);
        await rejected(Buffer.concat([tar([{path:'pax',type:'ExtendedHeader',content:paxRecord('path',Buffer.from([0xff]))}]).subarray(0,-1024),tar([{path:'safe',content:'x'}])]),/UTF-8/);
    });
    it('Rejects empty archives, absolute root directories and non-archive bytes',async()=>{
        for(const bytes of [zip([]),tar([]),zip([{path:'/',type:'Directory'}]),tar([{path:'/',type:'Directory'}]),Buffer.alloc(512,65)])await rejected(bytes);
    });
    it('Rejects symlinked input and staging directories without modifying their target',async()=>{
        await fs.writeFile(input,zip(source));const link=path.join(root,'link');await fs.symlink(input,link);await expect(readSourceArchive(link,output,signal())).rejects.toThrow();
        const directory=path.join(root,'linked-stage');await fs.symlink(output,directory);await expect(readSourceArchive(input,directory,signal())).rejects.toThrow();expect(await fs.readdir(output)).toEqual([]);
    });
});
