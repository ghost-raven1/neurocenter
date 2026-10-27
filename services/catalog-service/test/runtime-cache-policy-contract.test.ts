import {describe,expect,it} from 'vitest';
import {normalizeRuntimeCachePolicyPayload,normalizeRuntimeCachePolicyResult,RUNTIME_CACHE_POLICY_LIMITS} from '../../shared/runtime-cache-policy.cjs';
import {requiredJobFeatures} from '../../shared/feature-policy.cjs';
import {deviceJobRetryPolicy} from '../src/devices/device-job-retry';
import {canCancelBridgeJob} from '../src/operations/operation-action-policy';
import {assertRuntimeCacheJob} from '../src/devices/runtime-cache-jobs';
import type {Device} from '../src/devices/device-store';
const MiB=1024**2;
const set={schemaVersion:1,action:'set',expectedRevision:0,limitBytes:3072*MiB};
const report={schemaVersion:1,revision:1,limitBytes:3072*MiB,usedBytes:1891560621,defaultBytes:RUNTIME_CACHE_POLICY_LIMITS.defaultBytes,
    minBytes:RUNTIME_CACHE_POLICY_LIMITS.minBytes,maxBytes:RUNTIME_CACHE_POLICY_LIMITS.maxBytes,observedAt:'2026-10-24T00:00:00.000Z'};

describe('Machine runtime cache command and receipt contract',()=>{
    it('accepts zero retention only with the separate current-only capability',()=>{
        const payload={schemaVersion:2,action:'set-cleanup',expectedRevision:3,cleanup:{enabled:true,keepPrevious:0,minAgeDays:0}};
        const capabilities=['runtime-cache-policy-v1','bridge-update-cleanup-v1'];
        const device={id:'owned-device',email:'owner@example.test',role:'Разработчик',report:{capabilities}} as Device;
        const job:Parameters<typeof assertRuntimeCacheJob>[1]={kind:'runtime-cache-policy',payload,project_id:null,device_id:device.id,email:device.email,role:device.role};
        expect(()=>assertRuntimeCacheJob(device,job)).toThrow(/Обновите мост/);
        capabilities.push('bridge-update-current-only-v1');
        expect(()=>assertRuntimeCacheJob(device,job)).not.toThrow();
        expect(normalizeRuntimeCachePolicyPayload(payload)).toEqual(payload);
        capabilities.pop();
        expect(()=>assertRuntimeCacheJob(device,{...job,payload:{...payload,cleanup:{enabled:true,keepPrevious:1,minAgeDays:1}}})).not.toThrow();
    });
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
