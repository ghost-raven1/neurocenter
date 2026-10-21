import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import {DeviceJobs} from '../src/devices/device-jobs';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import type {Device,DeviceStore} from '../src/devices/device-store';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const {enqueue}=vi.hoisted(()=>({enqueue:vi.fn()}));
vi.mock('../src/devices/device-enqueue',()=>({enqueueDeviceJob:enqueue}));
const actor={email:'owner@example.test',activeRole:'Главный админ'},device:Device={id:'computer',email:actor.email,role:actor.activeRole,name:'QA',fingerprint:'a'.repeat(64),last_seen:null,revoked:false,
    report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','workspace-instance-v1','opencode-model-scan-v2'],bindings:[]}};
const denied=()=>new ForbiddenException({code:'feature-disabled',feature:'opencode_model_sync',blockedBy:[],message:'Синхронизация отключена'});
const job={id:'job',device_id:device.id,email:device.email,role:device.role,project_id:null,kind:'scan-opencode-models',state:'queued',payload:{scope:'global',deviceId:device.id},lease:'lease'};

describe('Fresh feature admission for bridge work',()=>{
    const query=vi.fn(),claims=vi.fn(),owned=vi.fn(),release=vi.fn();
    const service=new DeviceJobs({pool:{query,connect:async()=>({query,release})},access:{claims},owned} as unknown as DeviceStore,{} as never,{} as never,{} as never,{} as never);
    beforeEach(()=>{
        vi.clearAllMocks();vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined);owned.mockResolvedValue(device);
        claims.mockResolvedValue({email:actor.email,userRoles:[actor.activeRole],projects:[]});query.mockResolvedValue({rows:[],rowCount:0});enqueue.mockResolvedValue({id:job.id});
    });
    const create=()=>service.create(actor,{kind:job.kind,scope:'global',deviceId:device.id,requestKey:'11111111-1111-4111-8111-111111111111'});
    it.each([denied(),new ServiceUnavailableException('Флаги недоступны')])('disabled/unavailable capability refuses new work without enqueue',async error=>{
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(error);await expect(create()).rejects.toBe(error);expect(enqueue).not.toHaveBeenCalled();
        expect(requireFeaturesEnabled).toHaveBeenCalledWith(['opencode_model_sync']);
    });
    it('checks again at transactional admission after preparing the immutable payload',async()=>{
        enqueue.mockImplementationOnce(async(_pool,_view,_input,authorize)=>{vi.mocked(requireFeaturesEnabled).mockRejectedValue(denied());await authorize();});
        await expect(create()).rejects.toHaveProperty('status',403);expect(requireFeaturesEnabled).toHaveBeenCalledTimes(2);
    });
    it('queued scan is failed before delivery when its capability is disabled',async()=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')&&sql.includes("state='queued'")?[job]:[],rowCount:0}));
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(denied());expect(await service.claim(device)).toBeNull();
        const update=query.mock.calls.find(([sql])=>String(sql).startsWith("UPDATE bridge_jobs SET state='failed'"));
        expect(update?.[1]).toEqual([job.id,device.id,expect.any(String),'Синхронизация отключена']);
    });
    it('running scan requires a fresh capability immediately before local work',async()=>{
        query.mockResolvedValue({rows:[job],rowCount:1});vi.mocked(requireFeaturesEnabled).mockRejectedValue(denied());
        await expect(service.authorize(device,job.id,job.lease)).rejects.toHaveProperty('status',403);expect(requireFeaturesEnabled).toHaveBeenCalledWith(['opencode_model_sync']);
    });
    it('permission revocation wins before a feature lookup',async()=>{
        query.mockResolvedValue({rows:[job],rowCount:1});claims.mockResolvedValue({userRoles:[]});
        await expect(service.authorize(device,job.id,job.lease)).rejects.toHaveProperty('status',403);expect(requireFeaturesEnabled).not.toHaveBeenCalled();
    });
});
