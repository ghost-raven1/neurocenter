import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Device,DeviceStore} from '../src/devices/device-store';
import type {LearningService} from '../src/learning/learning.service';
import {DeviceLearningService} from '../src/learning/device-learning.service';
import {deviceLearningEnvelope} from '../src/learning/device-learning-auth';
import type {PoolClient} from 'pg';

const email='developer@example.test',projectId='prj-learning',bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111';
const target={projectId,bindingId,instanceId};
let device:Device;
const owned=vi.fn(),claims=vi.fn(),query=vi.fn(),context=vi.fn(),record=vi.fn(),propose=vi.fn(),observe=vi.fn();
const service=new DeviceLearningService({owned,access:{claims},pool:{query}} as unknown as DeviceStore,
    {deviceContext:context,recordDeviceExperience:record,proposeDeviceHypothesis:propose,appendDeviceExperience:observe} as unknown as LearningService);
beforeEach(()=>{
    vi.resetAllMocks();device={id:'device-fixture',email,role:'Разработчик',report:{bindings:[{...target,valid:true}]}} as unknown as Device;
    owned.mockImplementation(async()=>device);claims.mockImplementation(async()=>({email,userRoles:[device.role],projects:[{projectId,projectName:'Learning',role:device.role}]}));
    query.mockImplementation(async(sql:string)=>({rows:sql.includes('FROM bridge_devices')?[device]:[{id:projectId}]}));
    context.mockImplementation(async(_actor,_project,guard:(db:Pick<PoolClient,'query'>)=>Promise<void>)=>{await guard({query});return {projectId,entries:[]};});
    for(const method of [record,propose,observe])method.mockImplementation(async(_actor,_project,_input,_device,guard:(db:Pick<PoolClient,'query'>)=>Promise<void>)=>{await guard({query});return {projectId};});
});
describe('Narrow project-learning device transport',()=>{
    it('reads approved context with current membership and a transactional device snapshot',async()=>{
        expect(await service.context(device,target)).toEqual({projectId,entries:[]});expect(owned).toHaveBeenCalledTimes(2);
        expect(context).toHaveBeenCalledWith({email,activeRole:'Разработчик'},projectId,expect.any(Function));
        expect(query.mock.calls.some(([sql])=>String(sql).includes('FOR SHARE'))).toBe(true);expect(record).not.toHaveBeenCalled();
    });
    it.each(['record','propose','observe'] as const)('forwards only a verified device origin for %s',async method=>{
        const input={requestKey:'reported-fixture'};await service[method](device,{...target,input});
        const called=method==='record'?record:method==='propose'?propose:observe;
        expect(called).toHaveBeenCalledWith({email,activeRole:'Разработчик'},projectId,input,{deviceId:device.id,bindingId,instanceId},expect.any(Function));
    });
    it('permits observer context without permitting reports, proposals or observations',async()=>{
        device={...device,role:'Наблюдатель'};await expect(service.context(device,target)).resolves.toEqual({projectId,entries:[]});
        for(const method of ['record','propose','observe'] as const)await expect(service[method](device,{...target,input:{}})).rejects.toMatchObject({status:403});
        expect(record).not.toHaveBeenCalled();expect(propose).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled();
    });
    it.each(['rights','device','binding','instance','missing-project'])('refuses %s before accepting reported data',async change=>{
        if(change==='rights')claims.mockResolvedValue({email,userRoles:['Разработчик'],projects:[]});
        if(change==='device')owned.mockRejectedValue(Object.assign(Error('revoked'),{status:403}));
        if(change==='binding')device={...device,report:{bindings:[{...target,bindingId:'b'.repeat(64),valid:true}]}};
        if(change==='instance')device={...device,report:{bindings:[{...target,instanceId:'22222222-2222-4222-8222-222222222222',valid:true}]}};
        if(change==='missing-project')query.mockResolvedValue({rows:[]});
        await expect(service.record(device,{...target,input:{}})).rejects.toMatchObject({status:['rights','device'].includes(change)?403:change==='missing-project'?404:409});expect(record).not.toHaveBeenCalled();
    });
    it('rechecks device revocation inside the mutation transaction',async()=>{
        record.mockImplementation(async(_actor,_project,_input,_device,guard:(db:Pick<PoolClient,'query'>)=>Promise<void>)=>{
            await guard({query:vi.fn().mockResolvedValue({rows:[]}) as never});throw Error('must not reach write');
        });
        await expect(service.record(device,{...target,input:{}})).rejects.toMatchObject({status:401});
    });
    it('does not return context if access is removed while the core read runs',async()=>{
        context.mockImplementation(async()=>{claims.mockResolvedValue({email,userRoles:['Разработчик'],projects:[]});return {projectId,entries:[]};});
        await expect(service.context(device,target)).rejects.toMatchObject({status:403});
    });
    it.each([null,[],{...target,input:{}},{...target,projectId:[projectId]},{...target,bindingId:'latest'},
        {...target,instanceId:'other'},{...target,origin:'human'},{...target,approve:true},{...target,url:'http://other.invalid'}])('rejects malformed/authority-bearing context envelope',value=>{
        expect(()=>deviceLearningEnvelope(value)).toThrow();
    });
    it('requires an explicit write body and rejects hidden operation/actor fields',()=>{
        expect(()=>deviceLearningEnvelope(target,true)).toThrow();expect(()=>deviceLearningEnvelope({...target,input:{},actor:{email:'admin@example.test'}},true)).toThrow();
        expect(deviceLearningEnvelope({...target,input:{}},true)).toEqual({...target,input:{}});
    });
});
