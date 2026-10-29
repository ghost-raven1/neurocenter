import 'reflect-metadata';
import {Controller,Module,ForbiddenException,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {DeviceController} from '../src/devices/device.controller';
import {DeviceJobs} from '../src/devices/device-jobs';
import type {DeviceStore,Device} from '../src/devices/device-store';
import {FeaturePolicyGuard} from '../src/features/feature-policy.guard';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {deviceJobRequestHash} from '../src/devices/device-job-requests';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const {enqueue}=vi.hoisted(()=>({enqueue:vi.fn()}));
vi.mock('../src/devices/device-enqueue',()=>({enqueueDeviceJob:enqueue}));
const actor={email:'computer-owner@fixture.test',activeRole:'Наблюдатель'};
const device:Device={id:'11111111-1111-4111-8111-111111111111',email:actor.email,role:actor.activeRole,name:'Fixture',fingerprint:'a'.repeat(64),last_seen:null,revoked:false,
    report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','opencode-cli-v1']}};
const input={deviceId:device.id,kind:'inspect-opencode-cli',scope:'global',requestKey:'22222222-2222-4222-8222-222222222222'};

/** Actual Nest JSON parsing, routing and feature guard, with queue mutation isolated at the owned boundary. */
describe.sequential('Computer OpenCode browser HTTP admission',()=>{
    const query=vi.fn(),owned=vi.fn(),claims=vi.fn();
    const jobs=new DeviceJobs({pool:{query},owned,access:{claims}} as unknown as DeviceStore,{} as never,{} as never,{} as never,{} as never);
    const httpFetch=globalThis.fetch;
    let app:INestApplication,base:string;
    const post=(body:unknown)=>httpFetch(base+'/api/device-jobs',{method:'POST',headers:{'content-type':'application/json','x-neurocenter-internal':'computer-http-fixture',
        'x-bridge-actor':encodeURIComponent(JSON.stringify(actor))},body:JSON.stringify(body)});
    beforeAll(async()=>{
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','computer-http-fixture');
        class HttpController extends DeviceController {constructor(){super({} as never,jobs,{} as never,{} as never,{} as never);}}
        Controller()(HttpController);Reflect.defineMetadata('design:paramtypes',[],HttpController);
        class HttpFixture {}Module({controllers:[HttpController]})(HttpFixture);
        app=await NestFactory.create(HttpFixture,{logger:false});app.useGlobalGuards(new FeaturePolicyGuard());
        await app.listen(0,'127.0.0.1');base=await app.getUrl();
    });
    beforeEach(()=>{
        vi.clearAllMocks();query.mockResolvedValue({rows:[]});owned.mockResolvedValue(device);
        claims.mockResolvedValue({email:actor.email,userRoles:[actor.activeRole],projects:[]});enqueue.mockResolvedValue({id:'accepted',kind:input.kind,state:'queued'});
        vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined);
    });
    afterEach(()=>vi.unstubAllGlobals());
    afterAll(async()=>{await app?.close();vi.unstubAllEnvs();});
    it('accepts an observer-owned global request with no selected project or folder',async()=>{
        const response=await post(input);expect(response.status).toBe(201);expect(await response.json()).toMatchObject({id:'accepted',state:'queued'});
        expect(enqueue.mock.calls[0][2]).toMatchObject({deviceId:device.id,projectId:undefined,kind:input.kind,payload:{schemaVersion:1,scope:'global',deviceId:device.id}});
        expect(requireFeaturesEnabled).toHaveBeenCalledWith(['computer_setup']);
    });
    it('rejects uppercase device identity with 400 before owned lookup rather than treating it as another owner',async()=>{
        const deviceId='abcdefab-cdef-4abc-8def-abcdefabcdef';
        owned.mockResolvedValue({...device,id:deviceId});
        const response=await post({...input,deviceId:deviceId.toUpperCase()});
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({code:'computer-setup-invalid-request'});
        expect(owned).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();
    });
    it.each([{projectId:null},{projectId:''},{projectId:'prj-other'},{command:'opencode --version'},{args:['--version']},{path:'/private/bin/opencode'},
        {token:'private'},{scope:null},{scope:'project'},{scope:''},{deviceId:null},{deviceId:''},{requestKey:'-'.repeat(36)},{requestKey:null}])('returns 400 for unsupported fields or values %j before device lookup',async change=>{
        const response=await post({...input,...change});expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({code:'computer-setup-invalid-request'});
        expect(owned).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();
    });
    it.each(['deviceId','scope','requestKey'])('distinguishes omitted required field %s from a valid global request',async key=>{
        const body:Record<string,unknown>={...input};delete body[key];
        expect((await post(body)).status).toBe(400);expect(enqueue).not.toHaveBeenCalled();
    });
    it('returns an accepted exact request while OFF without another queue effect',async()=>{
        query.mockResolvedValue({rows:[{id:'accepted',request_hash:deviceJobRequestHash(actor.activeRole,input),request_device_id:device.id,state:'queued'}]});
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException({code:'feature-disabled',message:'Отключено'}));
        const response=await post(input);expect(response.status).toBe(201);expect(await response.json()).toMatchObject({id:'accepted'});
        expect(requireFeaturesEnabled).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();
        expect((await post({...input,scope:'project'})).status).toBe(400);
    });
    it('refuses new admission OFF, an unavailable capability and revoked ownership with their actual HTTP statuses',async()=>{
        vi.mocked(requireFeaturesEnabled).mockRejectedValueOnce(new ForbiddenException({code:'feature-disabled',message:'Отключено'}));
        expect((await post(input)).status).toBe(403);
        owned.mockResolvedValue({...device,report:{...device.report,capabilities:['durable-completions','managed-installations']}});
        const old=await post(input);expect(old.status).toBe(409);expect(await old.json()).toMatchObject({code:'computer-setup-upgrade-required'});
        owned.mockRejectedValue(new ForbiddenException('Чужой компьютер'));expect((await post(input)).status).toBe(403);
        expect(enqueue).not.toHaveBeenCalled();
    });
});
