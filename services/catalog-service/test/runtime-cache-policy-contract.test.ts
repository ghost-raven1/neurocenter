import {describe,expect,it} from 'vitest';
import {normalizeRuntimeCachePolicyPayload,normalizeRuntimeCachePolicyResult,RUNTIME_CACHE_POLICY_LIMITS} from '../../shared/runtime-cache-policy.cjs';
import {requiredJobFeatures} from '../../shared/feature-policy.cjs';
import {deviceJobRetryPolicy} from '../src/devices/device-job-retry';
import {canCancelBridgeJob} from '../src/operations/operation-action-policy';
const MiB=1024**2;
const set={schemaVersion:1,action:'set',expectedRevision:0,limitBytes:3072*MiB};
const report={schemaVersion:1,revision:1,limitBytes:3072*MiB,usedBytes:1891560621,defaultBytes:RUNTIME_CACHE_POLICY_LIMITS.defaultBytes,
    minBytes:RUNTIME_CACHE_POLICY_LIMITS.minBytes,maxBytes:RUNTIME_CACHE_POLICY_LIMITS.maxBytes,observedAt:'2026-10-24T00:00:00.000Z'};

describe('Machine runtime cache command and receipt contract',()=>{
    it('keeps the existing 2GiB default and accepts bounded integer MiB budgets',()=>{
        expect(RUNTIME_CACHE_POLICY_LIMITS.defaultBytes).toBe(2048*MiB);
        expect(normalizeRuntimeCachePolicyPayload({schemaVersion:1,action:'inspect'})).toEqual({schemaVersion:1,action:'inspect'});
        for(const limitBytes of [1024,2048,16384].map(value=>value*MiB))expect(normalizeRuntimeCachePolicyPayload({...set,limitBytes})).toMatchObject({limitBytes});
    });
    it.each([0,1024*MiB-1,1024*MiB+1,16384*MiB+1,Infinity,NaN,'3072',-1])('rejects an unsafe or fractional budget %s',limitBytes=>{
        expect(()=>normalizeRuntimeCachePolicyPayload({...set,limitBytes})).toThrow();
    });
    it.each([{...set,expectedRevision:-1},{...set,expectedRevision:0.5},{...set,path:'/private'},
        {schemaVersion:1,action:'inspect',limitBytes:2048*MiB},{...set,action:'cleanup'},null,[]])('does not accept unversioned commands, paths or deletion instructions: %j',value=>{
        expect(()=>normalizeRuntimeCachePolicyPayload(value)).toThrow();
    });
    it('reports numeric policy only and can inspect usage already above the effective budget',()=>{
        expect(normalizeRuntimeCachePolicyResult({...report,usedBytes:4*1024**3})).toMatchObject({usedBytes:4*1024**3});
        for(const extra of [{path:'/private'},{token:'private'},{accountId:'private'},{contents:'private'}])expect(()=>normalizeRuntimeCachePolicyResult({...report,...extra})).toThrow();
        expect(()=>normalizeRuntimeCachePolicyResult({...report,defaultBytes:4*1024**3})).toThrow();
        expect(()=>normalizeRuntimeCachePolicyResult({...report,observedAt:'yesterday'})).toThrow();
    });
    it('gates only new setting effects and does not advertise generic retry or active cancellation',()=>{
        expect(requiredJobFeatures('runtime-cache-policy',{runtimeCachePolicy:set})).toEqual(['computer_connections']);
        expect(requiredJobFeatures('runtime-cache-policy',set,true)).toEqual(['computer_connections']);
        expect(requiredJobFeatures('runtime-cache-policy',{runtimeCachePolicy:{schemaVersion:1,action:'inspect'}})).toEqual([]);
        expect(deviceJobRetryPolicy('runtime-cache-policy').retrySupported).toBe(false);
        expect(canCancelBridgeJob('runtime-cache-policy','queued')).toBe(true);
        for(const state of ['running','reconciling','succeeded'])expect(canCancelBridgeJob('runtime-cache-policy',state)).toBe(false);
    });
});
