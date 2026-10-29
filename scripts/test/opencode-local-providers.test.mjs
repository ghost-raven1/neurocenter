import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../../services/shared/opencode-local-providers.cjs';
const deviceId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222';
const request={deviceId,kind:'inspect-opencode-global-providers',scope:'global',requestKey:jobId};
const inventory={providers:[{id:'openai',modelIds:[],hasConfiguration:false,hasAuthentication:true,authentication:'oauth',enabled:true}],configurationFound:false,authenticationFound:true,overrideDetected:false,issues:[]};
const result={schemaVersion:1,scope:'global',deviceId,jobId,kind:request.kind,checkedAt:'2026-10-29T00:00:00.000Z',status:'checked',inventory};
test('only two fixed device-global requests are admitted; no caller files, keys or project',()=>{
    assert.deepEqual(contract.normalizeGlobalProvidersRequest(request),request);
    for(const patch of [{projectId:'x'},{apiKey:'SYNTHETIC_SECRET'},{path:'/tmp/config'},{kind:'run-command'},{scope:'project'}])assert.throws(()=>contract.normalizeGlobalProvidersRequest({...request,...patch}));
    assert.equal(contract.normalizeGlobalProvidersRequest({...request,kind:contract.OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB}).kind,'open-opencode-global-providers');
});
test('public inventory retains auth-only OAuth and multiple providers without auth values or secret fingerprints',()=>{
    assert.deepEqual(contract.normalizeGlobalProvidersResult(result,{deviceId,jobId,kind:request.kind}),result);
    for(const patch of [{apiKey:'SYNTHETIC_SECRET'},{authHash:'a'.repeat(64)},{path:'/tmp/auth.json'}])assert.throws(()=>contract.normalizeGlobalProvidersResult({...result,inventory:{...inventory,...patch}}));
    assert.throws(()=>contract.normalizeGlobalProvidersResult({...result,inventory:{...inventory,providers:[{...inventory.providers[0],key:'SYNTHETIC_SECRET'}]}}));
    assert.throws(()=>contract.normalizeGlobalProvidersResult(result,{deviceId:jobId,jobId,kind:request.kind}));
});
test('opening a private window is separate from read inventory and never means authentication or inference succeeded',()=>{
    assert.equal(contract.normalizeGlobalProvidersResult({...result,kind:'open-opencode-global-providers',status:'opened',expiresAt:'2026-10-29T00:15:00.000Z',inventory:undefined}).status,'opened');
    assert.throws(()=>contract.normalizeGlobalProvidersPayload({schemaVersion:1,scope:'global',deviceId},contract.OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB));
    assert.throws(()=>contract.normalizeGlobalProvidersResult({...result,status:'opened'}));
    assert.throws(()=>contract.normalizeGlobalProvidersResult({...result,kind:'open-opencode-global-providers'}));
});
test('one typed local policy admits validated smaller limits without changing structural ceilings',()=>{
    assert.equal(contract.globalProvidersLimits({NEUROCENTER_GLOBAL_PROVIDER_FILE_BYTES:'512'}).fileBytes,512);
    for(const value of ['0','NaN','-1','1.5','999999999999999999'])assert.throws(()=>contract.globalProvidersLimits({NEUROCENTER_GLOBAL_PROVIDER_FILE_BYTES:value}));
});
