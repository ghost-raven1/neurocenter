import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {installBundledOpenCode} from '../src/features/computer-setup/install.js';
const temporary:string[]=[];
afterEach(async()=>{for(const root of temporary.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-cli-install-')));temporary.push(root);
    const home=path.join(root,'home'),runtime=path.join(root,'runtime'),other=path.join(root,'path');for(const dir of[home,runtime,other])await fs.mkdir(dir,{mode:0o700});
    const sourceFile=path.join(runtime,'opencode-probe'),bytes=Buffer.from('PINNED_BUNDLED_EXECUTABLE_BYTES');await fs.writeFile(sourceFile,bytes,{mode:0o700});
    const destination=path.join(home,'.local/bin/opencode'),controller=new AbortController();
    const source={buildId:'a'.repeat(64),target:'darwin-arm64',version:'1.14.48' as const,sha256:createHash('sha256').update(bytes).digest('hex')};
    const payload={schemaVersion:1 as const,scope:'global' as const,deviceId:randomUUID(),source};
    const context={payload,jobId:randomUUID(),home,directories:[path.dirname(destination)],pathDirectories:[other],bridgeRoots:[runtime],sourceFile,signal:controller.signal,
        authorize:vi.fn(async()=>{}),assertSource:vi.fn(async()=>{}),probe:vi.fn(async(_file:string,current:()=>Promise<void>)=>{await current();return'1.14.48';}),beforePublish:vi.fn(async()=>{}),published:vi.fn(async()=>{})};
    return{root,home,sourceFile,destination,bytes,controller,context};
}
describe('bundled binary publication with harmless files and a fake fixed version probe, no executable/model',()=>{
    it('copies verified bytes but keeps absent PATH distinct, preserving all manual auth/config bytes',async()=>{
        const f=await fixture(),config=path.join(f.home,'.config/opencode'),auth=path.join(f.home,'.local/share/opencode');await fs.mkdir(config,{recursive:true});await fs.mkdir(auth,{recursive:true});
        const contents='{ "other": {"type":"oauth","access":"fixture"}, "unknown": [1,2] }\n';await fs.writeFile(path.join(auth,'auth.json'),contents);await fs.writeFile(path.join(config,'opencode.jsonc'),'// manual\n{"provider":{"one":{},"two":{}}}\n');
        const result=await installBundledOpenCode(f.context);expect(result).toMatchObject({status:'installed',installedVersion:'1.14.48',commandVersion:null,commandReady:false,nextAction:'inspect-path'});
        expect(await fs.readFile(f.destination)).toEqual(f.bytes);expect(await fs.readFile(path.join(auth,'auth.json'),'utf8')).toBe(contents);expect(await fs.readFile(path.join(config,'opencode.jsonc'),'utf8')).toBe('// manual\n{"provider":{"one":{},"two":{}}}\n');
        expect(f.context.beforePublish).toHaveBeenCalledOnce();expect(f.context.published).toHaveBeenCalledOnce();expect((await fs.readdir(path.dirname(f.destination))).sort()).toEqual(['opencode']);
    });
    it('confirms the actual normal PATH command only when it resolves and passes its fixed probe',async()=>{
        const f=await fixture();f.context.pathDirectories=[path.dirname(f.destination)];expect(await installBundledOpenCode(f.context)).toMatchObject({commandReady:true,commandVersion:'1.14.48',nextAction:'none'});
    });
    it('does not skip a bundled command earlier in PATH and claim the later user CLI is the shell command',async()=>{
        const f=await fixture(),first=path.join(f.root,'first');await fs.mkdir(first);await fs.symlink(f.sourceFile,path.join(first,'opencode'));
        await fs.mkdir(path.dirname(f.destination),{recursive:true});await fs.writeFile(f.destination,'MANUAL',{mode:0o700});
        f.context.pathDirectories=[first,path.dirname(f.destination)];
        expect(await installBundledOpenCode(f.context)).toMatchObject({status:'unchanged',installedVersion:'1.14.48',commandVersion:null,commandReady:false,nextAction:'inspect-path'});
        expect(f.context.probe.mock.calls.map(([file])=>file)).toEqual([f.destination]);
    });
    it('uses an existing newer manual CLI unchanged without staging or touching its directory',async()=>{
        const f=await fixture();await fs.mkdir(path.dirname(f.destination),{recursive:true});await fs.writeFile(f.destination,'MANUAL_NEWER',{mode:0o700});f.context.pathDirectories=[path.dirname(f.destination)];f.context.probe.mockImplementation(async(_file,current)=>{await current();return'1.15.0';});
        expect(await installBundledOpenCode(f.context)).toMatchObject({status:'unchanged',installedVersion:'1.15.0',commandReady:true});expect(await fs.readFile(f.destination,'utf8')).toBe('MANUAL_NEWER');expect(f.context.beforePublish).not.toHaveBeenCalled();
    });
    it.each([['1.14.48','2.2.2'],['2.2.2','1.14.48']])('preserves both existing CLI files and manual auth with first PATH %s, later %s',async(firstVersion,secondVersion)=>{
        const f=await fixture(),first=path.join(f.root,'first'),second=path.join(f.root,'second');for(const dir of[first,second])await fs.mkdir(dir);
        const binaries=[path.join(first,'opencode'),path.join(second,'opencode')],contents=['MANUAL_FIRST_'+firstVersion,'MANUAL_SECOND_'+secondVersion];
        for(let i=0;i<binaries.length;i++)await fs.writeFile(binaries[i],contents[i],{mode:0o700});
        const auth=path.join(f.home,'.local/share/opencode/auth.json'),config=path.join(f.home,'.config/opencode/opencode.jsonc');await fs.mkdir(path.dirname(auth),{recursive:true});await fs.mkdir(path.dirname(config),{recursive:true});
        const authBytes='{"manual":{"type":"oauth","access":"synthetic-preserved"},"unknown":[1,2]}\n',configBytes='// manual default and plugin\n{"model":"manual/model","plugin":["manual-plugin"]}\n';await fs.writeFile(auth,authBytes);await fs.writeFile(config,configBytes);
        f.context.directories=[first,second];f.context.pathDirectories=[first,second];f.context.probe.mockImplementation(async(file,current)=>{await current();const version=file===binaries[0]?firstVersion:secondVersion;return version==='2.2.2'?'opencode v2.2.2':version;});
        expect(await installBundledOpenCode(f.context)).toMatchObject({status:'unchanged',installedVersion:firstVersion,commandVersion:firstVersion,commandReady:true,nextAction:'none'});
        expect(await Promise.all(binaries.map(file=>fs.readFile(file,'utf8')))).toEqual(contents);expect(await fs.readFile(auth,'utf8')).toBe(authBytes);expect(await fs.readFile(config,'utf8')).toBe(configBytes);
        expect(f.context.probe.mock.calls.map(([file])=>file)).toEqual([binaries[0],binaries[0]]);expect(f.context.beforePublish).not.toHaveBeenCalled();expect(f.context.published).not.toHaveBeenCalled();await expect(fs.lstat(f.destination)).rejects.toHaveProperty('code','ENOENT');
    });
    it('rejects mismatched source SHA before any executable probe or publication',async()=>{
        const f=await fixture();f.context.payload.source.sha256='c'.repeat(64);await expect(installBundledOpenCode(f.context)).rejects.toHaveProperty('code','source-changed');expect(f.context.probe).not.toHaveBeenCalled();await expect(fs.lstat(f.destination)).rejects.toHaveProperty('code','ENOENT');
    });
    it('refuses a symlink destination parent and leaves its external directory untouched',async()=>{
        const f=await fixture(),outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.join(f.home,'.local'));
        await expect(installBundledOpenCode(f.context)).rejects.toHaveProperty('code','destination-unsafe');expect(await fs.readdir(outside)).toEqual([]);
    });
    it('cancels before publication and never overwrites a manual destination racing the durable marker',async()=>{
        const f=await fixture();f.context.beforePublish.mockImplementation(async()=>{f.controller.abort(Error('owned cancel'));});await expect(installBundledOpenCode(f.context)).rejects.toThrow('owned cancel');await expect(fs.lstat(f.destination)).rejects.toHaveProperty('code','ENOENT');
        const g=await fixture();g.context.beforePublish.mockImplementation(async()=>{await fs.writeFile(g.destination,'CONCURRENT_MANUAL',{flag:'wx',mode:0o700});});
        await expect(installBundledOpenCode(g.context)).rejects.toHaveProperty('code','destination-changed');expect(await fs.readFile(g.destination,'utf8')).toBe('CONCURRENT_MANUAL');expect(g.context.published).not.toHaveBeenCalled();
    });
    it('does not undo published bytes when confirmation fails; the durable owner must reconcile instead of recopying',async()=>{
        const f=await fixture();f.context.published.mockRejectedValue(Error('journal ACK lost'));await expect(installBundledOpenCode(f.context)).rejects.toThrow('journal ACK lost');expect(await fs.readFile(f.destination)).toEqual(f.bytes);expect(f.context.beforePublish).toHaveBeenCalledOnce();
    });
});
