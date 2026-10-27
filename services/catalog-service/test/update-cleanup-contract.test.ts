import {describe,expect,it,vi} from 'vitest';
import {normalizeRuntimeCachePolicyPayload,normalizeRuntimeCachePolicyResult,RUNTIME_CACHE_TARGET_LIMITS,BRIDGE_UPDATE_CURRENT_ONLY_CAPABILITY} from '../../shared/runtime-cache-policy.cjs';
import {requiredJobFeatures} from '../../shared/feature-policy.cjs';
import {assertRuntimeCacheJob,completeRuntimeCachePolicy} from '../src/devices/runtime-cache-jobs';

const cleanup={enabled:true,keepPrevious:2,minAgeDays:7};
const payload={schemaVersion:2,action:'set-cleanup',expectedRevision:1,cleanup};
const result={schemaVersion:2,revision:2,limitBytes:3*1024**3,usedBytes:123,defaultBytes:2*1024**3,minBytes:RUNTIME_CACHE_TARGET_LIMITS.minBytes,maxBytes:RUNTIME_CACHE_TARGET_LIMITS.maxBytes,observedAt:'2026-10-24T00:00:00.000Z',cleanup};
describe('Update cleanup command authority and completion contract',()=>{
    it('keeps a separate versioned retention command without paths or a cache-eviction instruction',()=>{
        expect(normalizeRuntimeCachePolicyPayload(payload)).toEqual(payload);expect(normalizeRuntimeCachePolicyResult(result)).toEqual(result);
        for(const wrong of [{...payload,path:'/private'},{...payload,cleanup:{...cleanup,path:'/private'}},{...payload,cleanup:{...cleanup,keepPrevious:-1}},{...payload,cleanup:{...cleanup,minAgeDays:-1}},{...payload,cleanup:{...cleanup,enabled:'yes'}},{...payload,action:'evict'}])expect(()=>normalizeRuntimeCachePolicyPayload(wrong)).toThrow();
        for(const selection of [{...cleanup,keepPrevious:0},{...cleanup,minAgeDays:0}]){
            expect(normalizeRuntimeCachePolicyPayload({...payload,cleanup:selection})).toEqual({...payload,cleanup:selection});
            expect(normalizeRuntimeCachePolicyResult({...result,cleanup:selection})).toEqual({...result,cleanup:selection});
            expect(()=>normalizeRuntimeCachePolicyPayload({...payload,schemaVersion:1,cleanup:selection})).toThrow();
        }
    });
    it('gates enabling while disabling and inspection remain usable with the feature off',()=>{
        expect(requiredJobFeatures('runtime-cache-policy',payload,true)).toEqual(['bridge_storage_cleanup']);
        expect(requiredJobFeatures('runtime-cache-policy',{...payload,cleanup:{...cleanup,enabled:false}},true)).toEqual([]);
        expect(requiredJobFeatures('runtime-cache-policy',{schemaVersion:2,action:'inspect'},true)).toEqual([]);
        const device={id:'d',email:'e',role:'Разработчик',report:{capabilities:['runtime-cache-policy-v1']}};
        const job={kind:'runtime-cache-policy',device_id:'d',email:'e',role:'Разработчик',project_id:null,payload};
        expect(()=>assertRuntimeCacheJob(device as never,job)).toThrow(/Обновите мост/);
        const legacyCleanup={...device,report:{capabilities:['runtime-cache-policy-v1','bridge-update-cleanup-v1']}};
        expect(()=>assertRuntimeCacheJob(legacyCleanup as never,job)).not.toThrow();
        const currentOnly={...device,report:{capabilities:[...legacyCleanup.report.capabilities,BRIDGE_UPDATE_CURRENT_ONLY_CAPABILITY]}};
        for(const selection of [{...cleanup,keepPrevious:0},{...cleanup,minAgeDays:0}]){
            const zeroJob={...job,payload:{...payload,cleanup:selection}};
            expect(()=>assertRuntimeCacheJob(legacyCleanup as never,zeroJob)).toThrow(/Обновите мост/);
            expect(()=>assertRuntimeCacheJob(currentOnly as never,zeroJob)).not.toThrow();
        }
    });
    it('rejects a succeeded receipt for another retention selection or protocol before database writes',async()=>{
        const db={query:vi.fn(async()=>({rows:[]}))};
        const job={id:'j',kind:'runtime-cache-policy',state:'running',project_id:null,email:'e',payload,result:{}};
        for(const mismatch of [{...result,cleanup:{...cleanup,keepPrevious:9}},{...result,revision:10},{...result,schemaVersion:1}]){
            await expect(completeRuntimeCachePolicy(db as never,job,{state:'succeeded',lease:'l',result:mismatch} as never)).rejects.toThrow(/Квитанция/);
        }
        expect(db.query).not.toHaveBeenCalled();
    });
    it('accepts a soft target outside the former corridor while keeping legacy commands strict',()=>{
        for(const limitBytes of [1024**2,20*1024**3,RUNTIME_CACHE_TARGET_LIMITS.maxBytes]){
            expect(normalizeRuntimeCachePolicyPayload({schemaVersion:2,action:'set',expectedRevision:0,limitBytes})).toMatchObject({limitBytes});
            expect(()=>normalizeRuntimeCachePolicyPayload({schemaVersion:1,action:'set',expectedRevision:0,limitBytes})).toThrow();
        }
        for(const limitBytes of [0,1024**2+1,Number.MAX_SAFE_INTEGER,Infinity,'1048576'])expect(()=>normalizeRuntimeCachePolicyPayload({schemaVersion:2,action:'set',expectedRevision:0,limitBytes})).toThrow();
    });
    it('requires target support for a soft target and accepts inspection on a target-only device',()=>{
        const device={id:'d',email:'e',role:'Разработчик',report:{capabilities:['runtime-cache-policy-v1','bridge-update-cleanup-v1']}};
        const job={kind:'runtime-cache-policy',device_id:'d',email:'e',role:'Разработчик',project_id:null,payload:{schemaVersion:2,action:'set',expectedRevision:0,limitBytes:1024**2}};
        expect(()=>assertRuntimeCacheJob(device as never,job)).toThrow(/Обновите мост/);
        const targetOnly={...device,report:{capabilities:['runtime-cache-policy-v1','runtime-cache-target-v2']}};
        expect(()=>assertRuntimeCacheJob(targetOnly as never,job)).not.toThrow();
        expect(()=>assertRuntimeCacheJob(targetOnly as never,{...job,payload:{schemaVersion:2,action:'inspect'}})).not.toThrow();
    });
    it('acknowledges over-target usage without rewriting a completed result and rejects a legacy over-limit write',async()=>{
        const target=1024**2,receipt={...result,limitBytes:target,usedBytes:2*target};
        const job={id:'j',kind:'runtime-cache-policy',state:'running',project_id:null,email:'e',payload:{schemaVersion:2,action:'set',expectedRevision:1,limitBytes:target},result:{}};
        const db={query:vi.fn(async()=>({rows:[]}))};
        await expect(completeRuntimeCachePolicy(db as never,job,{state:'succeeded',lease:'l',result:receipt} as never)).resolves.toEqual({ok:true,repeated:false});
        const writes=db.query.mock.calls.length;expect(writes).toBeGreaterThan(0);
        await expect(completeRuntimeCachePolicy(db as never,{...job,state:'succeeded',result:receipt},{state:'succeeded',lease:'l',result:receipt} as never)).resolves.toEqual({ok:true,repeated:true});
        expect(db.query).toHaveBeenCalledTimes(writes);
        const {cleanup:unused,...legacy}=receipt;
        await expect(completeRuntimeCachePolicy(db as never,{...job,payload:{...job.payload,schemaVersion:1,limitBytes:1024**3}},{state:'succeeded',lease:'l',result:{...legacy,schemaVersion:1,limitBytes:1024**3,usedBytes:2*1024**3,minBytes:1024**3,maxBytes:16*1024**3}} as never)).rejects.toThrow(/Квитанция/);
        expect(db.query).toHaveBeenCalledTimes(writes);
    });
});
