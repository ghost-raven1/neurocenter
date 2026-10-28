import 'reflect-metadata';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ForbiddenException,NotFoundException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {ModelTokenQuotasService} from '../src/model-token-quotas/model-token-quotas.service';
import type {ModelsService} from '../src/models/models.service';
import type {ModelUsageService} from '../src/model-usage/model-usage.service';
import type {ModelTokenQuotaReceipt,ModelTokenQuotaView} from '../src/model-token-quotas/model-token-quotas.types';
import type {Request} from 'express';
import {quotaRequestText} from '../src/model-token-quotas/model-token-quotas.model';

const key='12345678-1234-4234-8234-123456789abc',input={requestKey:key,expectedRevision:0,enabled:true,tokenLimit:1000,periodMs:86400000};
const policy={modelId:'model-quota',userEmail:'user@example.test',revision:1,enabled:true,tokenLimit:1000,periodMs:86400000,accountingStartedAt:'2026-10-28T00:00:00.000Z',updatedAt:'2026-10-28T00:00:00.000Z',updatedBy:'admin@example.test'};
const receipt:ModelTokenQuotaReceipt={modelId:policy.modelId,userEmail:policy.userEmail,writerEmail:'admin@example.test',requestKey:key,
    requestFingerprint:createHash('sha256').update(quotaRequestText('admin@example.test',policy.modelId,policy.userEmail,input)).digest('hex'),input,policy};
const req={} as Request;
beforeEach(()=>{const flags=defaultFeatureFlags();flags.user_model_token_quotas=false;vi.stubGlobal('fetch',vi.fn(async()=>Response.json(evaluateFeatureFlags(flags))));});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture(){
    const requireMain=vi.fn(async()=> 'admin@example.test'),get=vi.fn(async()=>({id:policy.modelId,runtime:'remote-openai',capability:'chat'}));
    const pool={query:vi.fn(async()=>({rows:[{email:policy.userEmail}]}))};
    const service=new ModelTokenQuotasService({requireMain,get} as unknown as ModelsService,{pool} as unknown as ModelUsageService);
    const save=vi.spyOn(service.repository,'save').mockResolvedValue(receipt),read=vi.spyOn(service.repository,'read').mockResolvedValue({modelId:policy.modelId,userEmail:policy.userEmail,policy,defaults:{periodMs:86400000},counters:{},coverage:{managedText:true,reason:''},canManage:true,featureEnabled:false} as ModelTokenQuotaView);
    const accepted=vi.spyOn(service.repository,'accepted').mockResolvedValue(null);
    const lookup=vi.spyOn(service.repository,'receipt').mockRejectedValue(new NotFoundException('not accepted'));
    return {service,requireMain,get,save,read,accepted,lookup,pool};
}
it('keeps MainAdmin reads and exact policy writes usable while enforcement is OFF',async()=>{
    const f=fixture();expect(await f.service.read(req,policy.modelId,'USER@example.test')).toMatchObject({featureEnabled:false,policy});
    expect(await f.service.save(req,policy.modelId,policy.userEmail,input)).toEqual(receipt);
    expect(f.save).toHaveBeenCalledOnce();expect(f.save.mock.calls[0].slice(0,4)).toEqual(['admin@example.test',expect.objectContaining({id:policy.modelId}),policy.userEmail,input]);
});
it('fresh MainAdmin rejection precedes any policy write and never changes an existing receipt',async()=>{
    const f=fixture();f.requireMain.mockRejectedValue(new ForbiddenException('revoked'));
    await expect(f.service.save(req,policy.modelId,policy.userEmail,input)).rejects.toHaveProperty('status',403);expect(f.save).not.toHaveBeenCalled();
    const switched=fixture();switched.requireMain.mockResolvedValueOnce('admin@example.test').mockResolvedValueOnce('other@example.test');
    await expect(switched.service.save(req,policy.modelId,policy.userEmail,input)).rejects.toHaveProperty('status',403);
    expect(switched.get).not.toHaveBeenCalled();expect(switched.save).not.toHaveBeenCalled();
});
it('withholds a completed read after actor replacement instead of exposing another user budget',async()=>{
    const f=fixture();f.requireMain.mockResolvedValueOnce('admin@example.test').mockResolvedValueOnce('other@example.test');
    await expect(f.service.read(req,policy.modelId,policy.userEmail)).rejects.toHaveProperty('status',403);
});
it('an unknown save ACK returns a stable error without a server-generated replacement key or automatic write replay',async()=>{
    const f=fixture();f.save.mockRejectedValue(new Error('COMMIT acknowledgement lost'));
    await expect(f.service.save(req,policy.modelId,policy.userEmail,input)).rejects.toMatchObject({response:{code:'MODEL_TOKEN_QUOTA_SAVE_UNCONFIRMED'}});
    expect(f.save).toHaveBeenCalledOnce();expect(f.save.mock.calls[0][3]).toEqual(input);
});
it('request recovery is writer/model/user/key scoped and does not require a current model or target row',async()=>{
    const f=fixture();f.lookup.mockResolvedValue(receipt);expect(await f.service.receipt(req,policy.modelId,policy.userEmail,key)).toEqual(receipt);
    expect(f.lookup).toHaveBeenCalledExactlyOnceWith('admin@example.test',policy.modelId,policy.userEmail,key);expect(f.pool.query).not.toHaveBeenCalled();
});
it('replays an accepted PUT before a deleted catalog lookup and rejects changed-body key reuse without another save',async()=>{
    const f=fixture();f.accepted.mockResolvedValue(receipt);f.get.mockRejectedValue(new NotFoundException('model deleted'));
    expect(await f.service.save(req,policy.modelId,policy.userEmail,input)).toEqual(receipt);
    await expect(f.service.save(req,policy.modelId,policy.userEmail,{...input,tokenLimit:1001}))
        .rejects.toMatchObject({response:{code:'MODEL_TOKEN_QUOTA_REQUEST_CONFLICT'}});
    expect(f.requireMain).toHaveBeenCalledTimes(4);expect(f.get).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();
});
it.each([{modelId:'model-deleted',userEmail:policy.userEmail},{modelId:policy.modelId,userEmail:'deleted-user@example.test'}])('rejects a writer key rebound to another requested target before any deleted-target lookup %j',async target=>{
    const f=fixture();f.accepted.mockResolvedValue(receipt);f.get.mockRejectedValue(new NotFoundException('target deleted'));
    await expect(f.service.save(req,target.modelId,target.userEmail,input)).rejects.toMatchObject({response:{code:'MODEL_TOKEN_QUOTA_REQUEST_CONFLICT'}});
    expect(f.accepted).toHaveBeenCalledExactlyOnceWith('admin@example.test',key);expect(f.requireMain).toHaveBeenCalledTimes(2);
    expect(f.get).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();expect(f.lookup).not.toHaveBeenCalled();
});
