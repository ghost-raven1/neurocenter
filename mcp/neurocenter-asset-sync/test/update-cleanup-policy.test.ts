import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {providerFixture,noop} from './opencode-provider.fixture.js';
import {runRuntimeCachePolicyJob,recoverRuntimeCachePolicyCompletions} from '../src/features/runtime-artifacts/cache-policy.js';
import {readBridgeCleanupPolicy,runtimeCacheLimit,runtimeCacheReceiptKey} from '../src/features/runtime-artifacts/policy-store.js';
import * as privateStore from '../src/features/local-configuration/private-store.js';
import {stateDir} from '../src/bridge/state.js';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const close of cleanups.splice(0))await close();});
const command=(payload:unknown)=>({id:randomUUID(),lease:randomUUID(),payload});
const cleanup={enabled:false,keepPrevious:3,minAgeDays:14};
async function fixture(){const local=await providerFixture();cleanups.push(local.cleanup);return {local,run:(job:ReturnType<typeof command>,authorize=noop)=>runRuntimeCachePolicyJob(job,local.descriptor.deviceId,authorize)};}

describe('Update retention settings keep the runtime budget and one durable intent',()=>{
    it('inspects defaults, changes retention, and fences an older limit draft with the same revision',async()=>{
        const {run}=await fixture();
        expect((await run(command({schemaVersion:2,action:'inspect'}))).result).toMatchObject({schemaVersion:2,revision:0,limitBytes:2*1024**3,cleanup:{enabled:true,keepPrevious:2,minAgeDays:7}});
        expect((await run(command({schemaVersion:2,action:'set-cleanup',expectedRevision:0,cleanup}))).result).toMatchObject({revision:1,cleanup});
        await expect(run(command({schemaVersion:1,action:'set',expectedRevision:0,limitBytes:3*1024**3}))).rejects.toThrow(/другом окне/);
        await run(command({schemaVersion:1,action:'set',expectedRevision:1,limitBytes:3*1024**3}));
        expect(await runtimeCacheLimit()).toBe(3*1024**3);expect(await readBridgeCleanupPolicy()).toEqual(cleanup);
        expect((await run(command({schemaVersion:2,action:'inspect'}))).result).toMatchObject({revision:2,cleanup});
    });
    it('delivers the retained cleanup setting after a lost receipt without applying another change',async()=>{
        const {run}=await fixture(),job=command({schemaVersion:2,action:'set-cleanup',expectedRevision:0,cleanup});
        const write=privateStore.writePrivateConfiguration;
        vi.spyOn(privateStore,'writePrivateConfiguration').mockImplementation(async(...args)=>{if(args[0]===runtimeCacheReceiptKey(job.id))throw Error('receipt unavailable');return write(...args);});
        await expect(run(job)).rejects.toMatchObject({localChangesCommitted:true});
        expect(await readBridgeCleanupPolicy()).toEqual(cleanup);expect(await runtimeCacheLimit()).toBe(2*1024**3);
        const completed=vi.fn(noop);await recoverRuntimeCachePolicyCompletions(completed);
        expect(completed).toHaveBeenCalledWith(expect.objectContaining({id:job.id,state:'succeeded',result:expect.objectContaining({schemaVersion:2,revision:1,cleanup})}));
        vi.restoreAllMocks();const authorize=vi.fn(async()=>{throw Error('must not reapply');});
        expect((await run(job,authorize)).result).toMatchObject({revision:1,cleanup});expect(authorize).not.toHaveBeenCalled();
    });
    it('does not apply retention after the final authority check fails',async()=>{
        const {run}=await fixture();let calls=0;
        await expect(run(command({schemaVersion:2,action:'set-cleanup',expectedRevision:0,cleanup}),async()=>{if(++calls===2)throw Error('revoked');})).rejects.toThrow('revoked');
        expect(await readBridgeCleanupPolicy()).toEqual({enabled:true,keepPrevious:2,minAgeDays:7});expect(await runtimeCacheLimit()).toBe(2*1024**3);
    });
    it('persists a target below usage without deleting files and keeps the default cleanup receipt readable',async()=>{
        const {run}=await fixture(),root=path.join(stateDir(),'runtime-artifacts');
        await fs.mkdir(root,{recursive:true,mode:0o700});
        const file=path.join(root,'existing-package'),bytes=Buffer.alloc(2*1024**2,7);await fs.writeFile(file,bytes,{mode:0o600});
        const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex'),original=digest(bytes);
        const job=command({schemaVersion:2,action:'set',expectedRevision:0,limitBytes:1024**2});
        const saved=await run(job);
        expect(saved.result).toMatchObject({schemaVersion:2,revision:1,limitBytes:1024**2,cleanup:{enabled:true,keepPrevious:2,minAgeDays:7}});
        expect(saved.result.usedBytes).toBeGreaterThanOrEqual(bytes.length);
        expect(await runtimeCacheLimit()).toBe(1024**2);expect(digest(await fs.readFile(file))).toBe(original);
        expect((await run(command({schemaVersion:2,action:'inspect'}))).result).toMatchObject({revision:1,limitBytes:1024**2,usedBytes:saved.result.usedBytes});
        const authorize=vi.fn(async()=>{throw Error('must not reapply');});
        expect((await run(job,authorize)).result).toMatchObject({revision:1,limitBytes:1024**2});expect(authorize).not.toHaveBeenCalled();
        expect(await readBridgeCleanupPolicy()).toEqual({enabled:true,keepPrevious:2,minAgeDays:7});expect(digest(await fs.readFile(file))).toBe(original);
    });
    it('accepts a target above 16GiB and retains it across a retention change',async()=>{
        const {run}=await fixture();
        await run(command({schemaVersion:2,action:'set',expectedRevision:0,limitBytes:20*1024**3}));
        await run(command({schemaVersion:2,action:'set-cleanup',expectedRevision:1,cleanup}));
        expect(await runtimeCacheLimit()).toBe(20*1024**3);expect(await readBridgeCleanupPolicy()).toEqual(cleanup);
        expect((await run(command({schemaVersion:2,action:'inspect'}))).result).toMatchObject({revision:2,limitBytes:20*1024**3,cleanup});
    });
});
