import 'reflect-metadata';
import {Controller,Module,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {DeviceController} from '../src/devices/device.controller';
import {DeviceJobs} from '../src/devices/device-jobs';
import type {DeviceStore} from '../src/devices/device-store';
import {FeaturePolicyGuard} from '../src/features/feature-policy.guard';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>{throw Error('Flags are unavailable or disabled.');})}));

const actor={email:'receipt-owner@example.test',activeRole:'Разработчик'};
const requestKey='11111111-1111-4111-8111-111111111111';
const requestFingerprint='c'.repeat(64);
const claims={email:actor.email,userRoles:[actor.activeRole],projects:[{projectId:'prj-receipt',projectName:'Receipt',role:actor.activeRole}]};
const job={id:'accepted-job',deviceId:'owned-device',projectId:'prj-receipt',kind:'sync-learning-memory',state:'succeeded',
    assetId:'learning',assetKind:'plugin',version:'7',bindingId:'a'.repeat(64),expectedManifest:'b'.repeat(64),expectedInstanceId:'22222222-2222-4222-8222-222222222222'};

/** Real Nest routing and error responses; relational visibility and projection are covered by the owned PostgreSQL suite. */
describe.sequential('Exact device request receipt HTTP contract',()=>{
    const query=vi.fn(),connect=vi.fn(),readClaims=vi.fn(),egress=vi.fn();
    const jobs=new DeviceJobs({pool:{query,connect},access:{claims:readClaims}} as unknown as DeviceStore,{} as never,{} as never,{} as never,{} as never);
    const expire=vi.spyOn(jobs as unknown as {expire():Promise<void>},'expire').mockRejectedValue(Error('Receipt must not expire jobs.'));
    const create=vi.spyOn(jobs,'create').mockRejectedValue(Error('Receipt must not create jobs.'));
    const list=vi.spyOn(jobs,'list').mockRejectedValue(Error('Receipt must not sweep history.'));
    const httpFetch=globalThis.fetch;
    let app:INestApplication,base:string;
    const headers=(token='receipt-http-only')=>({'x-neurocenter-internal':token,'x-bridge-actor':encodeURIComponent(JSON.stringify(actor))});
    const get=(key=requestKey,token?:string)=>httpFetch(base+'/api/device-jobs/requests/'+encodeURIComponent(key),{headers:headers(token)});
    beforeAll(async()=>{
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','receipt-http-only');
        class ReceiptHttpController extends DeviceController {
            constructor(){super({} as never,jobs,{} as never,{} as never,{} as never);}
        }
        Controller()(ReceiptHttpController);Reflect.defineMetadata('design:paramtypes',[],ReceiptHttpController);
        class HttpFixture {}Module({controllers:[ReceiptHttpController]})(HttpFixture);
        app=await NestFactory.create(HttpFixture,{logger:false});app.useGlobalGuards(new FeaturePolicyGuard());
        await app.listen(0,'127.0.0.1');base=await app.getUrl();
    });
    beforeEach(()=>{
        vi.clearAllMocks();query.mockResolvedValue({rows:[{...job,requestFingerprint}],rowCount:1});readClaims.mockResolvedValue(claims);
        connect.mockRejectedValue(Error('Receipt must not open a mutation transaction.'));
        egress.mockRejectedValue(Error('Receipt must not contact a provider or notification service.'));vi.stubGlobal('fetch',egress);
    });
    afterEach(()=>vi.unstubAllGlobals());
    afterAll(async()=>{await app?.close();vi.restoreAllMocks();vi.unstubAllEnvs();});
    it('recovers an accepted response with frozen client fences even when feature checks are unavailable',async()=>{
        const response=await get();expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({requestKey,requestFingerprint,job});expect(readClaims).toHaveBeenCalledWith(actor.email);
        expect(query).toHaveBeenCalledOnce();expect(connect).not.toHaveBeenCalled();expect(expire).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();expect(requireFeaturesEnabled).not.toHaveBeenCalled();expect(egress).not.toHaveBeenCalled();
    });
    it('keeps an unfingerprinted legacy receipt readable without claiming exact request identity',async()=>{
        query.mockResolvedValue({rows:[{...job,requestFingerprint:null}],rowCount:1});const response=await get();
        expect(response.status).toBe(200);expect(await response.json()).toEqual({requestKey,requestFingerprint:null,job});
    });
    it('returns an uncached 404 for a receipt that has not been accepted',async()=>{
        query.mockResolvedValue({rows:[],rowCount:0});const response=await get();
        expect(response.status).toBe(404);expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toMatchObject({statusCode:404});expect(create).not.toHaveBeenCalled();expect(egress).not.toHaveBeenCalled();
    });
    it.each(['not-a-key','A'.repeat(36),'1'.repeat(35),'1'.repeat(37)])('rejects malformed request key %s before the SQL read',async key=>{
        const response=await get(key);expect(response.status).toBe(400);expect(response.headers.get('cache-control')).toBe('no-store');
        expect(query).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
    });
    it('rejects a revoked active role before reading any receipt',async()=>{
        readClaims.mockResolvedValue({...claims,userRoles:[]});const response=await get();
        expect(response.status).toBe(403);expect(response.headers.get('cache-control')).toBe('no-store');expect(query).not.toHaveBeenCalled();
    });
    it('rejects a disabled account and a forged gateway identity before reading the receipt',async()=>{
        const {ForbiddenException}=await import('@nestjs/common');readClaims.mockRejectedValue(new ForbiddenException('Account disabled.'));
        expect((await get()).status).toBe(403);expect(query).not.toHaveBeenCalled();readClaims.mockClear();
        expect((await get(requestKey,'wrong-gateway')).status).toBe(403);expect(readClaims).not.toHaveBeenCalled();
    });
    it('rereads the current project scope after membership changes',async()=>{
        expect((await get()).status).toBe(200);readClaims.mockResolvedValue({...claims,projects:[]});query.mockResolvedValue({rows:[],rowCount:0});
        expect((await get()).status).toBe(404);expect(readClaims).toHaveBeenCalledTimes(2);
        expect(query.mock.calls.at(-1)?.[1]).toEqual([actor.email,requestKey,false,[]]);
    });
});
