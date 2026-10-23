import fs from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {providerFixture,noop} from './opencode-provider.fixture.js';
import {hash,stateDir,readState,writeState} from '../src/bridge/state.js';
import {canonicalV4,type Package} from '../src/bridge/package.js';
import {ensureRuntimeArtifact} from '../src/features/runtime-artifacts/cache.js';
import {runtimeArtifactTarget} from '../src/features/runtime-artifacts/model.js';
import {runRuntimeCachePolicyJob,recoverRuntimeCachePolicyCompletions,acknowledgeRuntimeCachePolicyReceipt} from '../src/features/runtime-artifacts/cache-policy.js';
import {readRuntimeCachePolicy,runtimeCacheLimit,runtimeCachePolicyKey,runtimeCacheReceiptKey} from '../src/features/runtime-artifacts/policy-store.js';
import * as privateStore from '../src/features/local-configuration/private-store.js';
import {saveCompletion,deliverCompletions,pendingCompletions} from '../src/bridge/completions.js';
import * as atomicFile from '../src/bridge/atomic-file.js';

const GiB=1024**3,cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await Promise.all(cleanup.splice(0).map(close=>close()));});
async function fixture(){
    const local=await providerFixture();cleanup.push(local.cleanup);
    const deviceId=local.descriptor.deviceId;
    const job=(action:'inspect'|'set'='set',expectedRevision=0,limitBytes=3*GiB)=>({id:randomUUID(),lease:randomUUID(),payload:action==='inspect'?{schemaVersion:1,action}:{schemaVersion:1,action,expectedRevision,limitBytes}});
    return {...local,deviceId,job,run:(value:ReturnType<typeof job>,authorize=noop)=>runRuntimeCachePolicyJob(value,deviceId,authorize)};
}
async function sparse(bytes:number){const root=path.join(stateDir(),'runtime-artifacts');await fs.mkdir(root,{recursive:true,mode:0o700});const file=await fs.open(path.join(root,'qa-existing'),'wx',0o600);try{await file.truncate(bytes);}finally{await file.close();}return root;}
function artifact(){
    const {archive,descriptor}=artifactFixture(undefined,runtimeArtifactTarget());
    const pkg:Package={schemaVersion:5,plugin:{id:'qa-cache',name:'QA cache',kind:'mcp',version:1},config:{extra:{runtimeArtifacts:[descriptor]}},files:[],manifest:{sha256:'',filesCount:0}};
    pkg.manifest.sha256=hash(JSON.stringify(canonicalV4({schemaVersion:pkg.schemaVersion,plugin:pkg.plugin,config:pkg.config,files:[]})));
    return {archive,pkg};
}

describe('Computer runtime cache policy preserves packages and confirms writes',()=>{
    it('reports the original default and changes no policy on inspection',async()=>{
        const f=await fixture(),value=await f.run(f.job('inspect'));
        expect(value.result).toMatchObject({schemaVersion:1,revision:0,limitBytes:2*GiB,defaultBytes:2*GiB,minBytes:GiB,maxBytes:16*GiB});
        expect(await readRuntimeCachePolicy()).toBeUndefined();expect(await runtimeCacheLimit()).toBe(2*GiB);
    });
    it('an explicit larger budget admits the same real archive and retains the previous sparse file',async()=>{
        const f=await fixture(),root=await sparse(2*GiB-128),{archive,pkg}=artifact();
        const download=vi.fn(async()=>Readable.from([archive]));
        await expect(ensureRuntimeArtifact(pkg,{download})).rejects.toMatchObject({code:'runtime-cache-full'});expect(download).not.toHaveBeenCalled();
        expect((await f.run(f.job())).result).toMatchObject({revision:1,limitBytes:3*GiB});
        const result=await ensureRuntimeArtifact(pkg,{download});expect(result?.entrypoint).toBeTruthy();expect(download).toHaveBeenCalledOnce();
        expect((await fs.stat(path.join(root,'qa-existing'))).size).toBe(2*GiB-128);
    });
    it('raising the cache limit retains the separate physical disk guard',async()=>{
        const f=await fixture();await f.run(f.job());const {archive,pkg}=artifact();
        vi.spyOn(fs,'statfs').mockResolvedValue({bavail:0n,bsize:4096n} as never);
        const download=vi.fn(async()=>Readable.from([archive]));
        await expect(ensureRuntimeArtifact(pkg,{download})).rejects.toMatchObject({code:'disk-full'});expect(download).not.toHaveBeenCalled();
    });
    it('rejects shrinking below actual usage and reports an over-budget cache without deleting anything',async()=>{
        const f=await fixture();await sparse(2*GiB+4096);
        expect((await f.run(f.job('inspect'))).result.usedBytes).toBeGreaterThan(2*GiB);
        await expect(f.run(f.job('set',0,GiB))).rejects.toThrow(/меньше занятого/);expect(await readRuntimeCachePolicy()).toBeUndefined();
    });
    it('a stale revision cannot replace a later confirmed limit',async()=>{
        const f=await fixture();await f.run(f.job());await expect(f.run(f.job('set',0,4*GiB))).rejects.toThrow(/другом окне/);
        expect(await readRuntimeCachePolicy()).toMatchObject({revision:1,limitBytes:3*GiB});
    });
    it('revocation at the async final admission preserves the previous policy and recovers an honest failure',async()=>{
        const f=await fixture(),job=f.job();let checks=0;
        await expect(f.run(job,async()=>{await Promise.resolve();if(++checks===2)throw new Error('revoked');})).rejects.toThrow('revoked');
        expect(await readRuntimeCachePolicy()).toBeUndefined();const save=vi.fn(noop);await recoverRuntimeCachePolicyCompletions(save);
        expect(save).toHaveBeenCalledWith(expect.objectContaining({id:job.id,state:'failed',result:{}}));expect(await runtimeCacheLimit()).toBe(2*GiB);
    });
    it('a changed device identity blocks a new setting',async()=>{
        const f=await fixture(),previous=await readState<Record<string,unknown>>('credentials');
        await expect(f.run(f.job(),async()=>{await writeState('credentials',{...previous,deviceId:randomUUID()});})).rejects.toThrow(/Подключение/);
        expect(await readRuntimeCachePolicy()).toBeUndefined();
    });
    it('an active archive preparation lock blocks a policy change',async()=>{
        const f=await fixture(),root=await sparse(10);await fs.writeFile(path.join(root,'.lock'),JSON.stringify({id:randomUUID(),pid:process.pid}),{mode:0o600});
        await expect(f.run(f.job())).rejects.toThrow(/Другой процесс/);expect(await readRuntimeCachePolicy()).toBeUndefined();
    });
    it('recovers a committed rename after private receipt failure without repeating the setting or checking a new mutation grant',async()=>{
        const f=await fixture(),job=f.job(),write=privateStore.writePrivateConfiguration;
        vi.spyOn(privateStore,'writePrivateConfiguration').mockImplementation(async(...args)=>{if(args[0]===runtimeCacheReceiptKey(job.id))throw new Error('receipt IO failure');return write(...args);});
        await expect(f.run(job)).rejects.toMatchObject({localChangesCommitted:true});expect(await readRuntimeCachePolicy()).toMatchObject({revision:1,limitBytes:3*GiB});
        vi.restoreAllMocks();const save=vi.fn(noop);await recoverRuntimeCachePolicyCompletions(save);
        expect(save).toHaveBeenCalledWith(expect.objectContaining({id:job.id,lease:job.lease,state:'succeeded',result:expect.objectContaining({revision:1,limitBytes:3*GiB})}));
        const authorize=vi.fn(async()=>{throw new Error('flag OFF');});expect((await f.run(job,authorize)).result.revision).toBe(1);expect(authorize).not.toHaveBeenCalled();
        expect((await readRuntimeCachePolicy())?.revision).toBe(1);
    });
    it('an intent interrupted before rename cannot recover a false success',async()=>{
        const f=await fixture(),job=f.job(),rename=fs.rename.bind(fs);
        vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{if(String(to).endsWith(runtimeCachePolicyKey+'.json'))throw new Error('rename failed');return rename(from,to);});
        await expect(f.run(job)).rejects.toMatchObject({localChangesCommitted:true});vi.restoreAllMocks();
        const save=vi.fn(noop);await recoverRuntimeCachePolicyCompletions(save);expect(save).toHaveBeenCalledWith(expect.objectContaining({id:job.id,state:'failed',result:{}}));
        expect(await readRuntimeCachePolicy()).toBeUndefined();
    });
    it('recovery repeats the private directory fsync before acknowledging a visible rename',async()=>{
        const f=await fixture(),job=f.job(),sync=atomicFile.syncDirectory,events:string[]=[];let first=true;
        vi.spyOn(atomicFile,'syncDirectory').mockImplementation(async directory=>{
            if(directory.endsWith('/local-configuration')&&first){first=false;throw new Error('directory fsync failed');}await sync(directory);
            if(directory.endsWith('/local-configuration'))events.push('fsync-completed');
        });
        await expect(f.run(job)).rejects.toMatchObject({localChangesCommitted:true});const save=vi.fn(async()=>{events.push('save');});expect(events).toEqual([]);
        await recoverRuntimeCachePolicyCompletions(save);expect(save).toHaveBeenCalledOnce();
        expect(events).toEqual(['fsync-completed','save']);
        expect(save.mock.calls[0]?.[0]).toMatchObject({state:'succeeded',result:{revision:1}});
    });
    it('persistent private directory fsync failure prevents a recovered success receipt',async()=>{
        const f=await fixture(),job=f.job(),sync=atomicFile.syncDirectory;
        vi.spyOn(atomicFile,'syncDirectory').mockImplementation(async directory=>{if(directory.endsWith('/local-configuration'))throw new Error('fsync unavailable');await sync(directory);});
        await expect(f.run(job)).rejects.toMatchObject({localChangesCommitted:true});const save=vi.fn(noop);
        await expect(recoverRuntimeCachePolicyCompletions(save)).rejects.toThrow('fsync unavailable');expect(save).not.toHaveBeenCalled();
        expect((await readState<unknown[]>('runtime-cache-policy-pending'))?.length).toBe(1);
    });
    it('lost ACK replays one exact result and does not overwrite a newer setting',async()=>{
        const f=await fixture(),first=f.job(),second=f.job('set',1,4*GiB);const a=await f.run(first);await f.run(second);
        await saveCompletion({id:first.id,lease:first.lease,deviceId:f.deviceId,...a});const failed=vi.fn(async()=>{throw new Error('lost ACK');});
        await expect(deliverCompletions(failed)).rejects.toThrow('lost ACK');const ok=vi.fn(noop);await deliverCompletions(ok);
        expect(ok.mock.calls[0]?.[0]).toEqual(failed.mock.calls[0]?.[0]);expect(await pendingCompletions()).toEqual([]);
        expect((await f.run(first,async()=>{throw new Error('OFF');})).result.limitBytes).toBe(3*GiB);expect(await runtimeCacheLimit()).toBe(4*GiB);
        const pending=await readState<Array<{jobId:string}>>('runtime-cache-policy-pending');expect(pending?.map(v=>v.jobId)).toEqual([second.id]);
    });
    it('unrelated completion recovery does not create or lock the runtime cache',async()=>{
        await fixture();await recoverRuntimeCachePolicyCompletions(noop);await acknowledgeRuntimeCachePolicyReceipt(randomUUID());
        await expect(fs.stat(path.join(stateDir(),'runtime-artifacts'))).rejects.toMatchObject({code:'ENOENT'});
    });
    it('rejects a damaged local policy instead of silently falling back to the default',async()=>{
        await fixture();await privateStore.writePrivateConfiguration(runtimeCachePolicyKey,{schemaVersion:1,revision:1,limitBytes:16*GiB},undefined);
        await expect(runtimeCacheLimit()).rejects.toThrow(/Повреждена/);
    });
    it('async beforeCommit rechecks CAS after the awaited admission',async()=>{
        await fixture();const key=hash('qa-async-CAS'),value={manual:true};
        await expect(privateStore.writePrivateConfiguration(key,{next:true},undefined,async()=>{
            await Promise.resolve();await fs.writeFile(path.join(stateDir(),'local-configuration',key+'.json'),JSON.stringify(value),{mode:0o600});
        })).rejects.toThrow(/другом окне/);expect(await privateStore.readPrivateConfiguration(key)).toEqual(value);
    });
});
