import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import {DeviceJobs} from '../src/devices/device-jobs';
import type {Device,DeviceStore} from '../src/devices/device-store';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const {enqueue}=vi.hoisted(()=>({enqueue:vi.fn()}));
vi.mock('../src/devices/device-enqueue',()=>({enqueueDeviceJob:enqueue}));

describe('Retry re-enters current bridge admission',()=>{
    const actor={email:'owner@example.test',activeRole:'Разработчик'},binding='a'.repeat(64),requestKey='11111111-1111-4111-8111-111111111111';
    const query=vi.fn(),claims=vi.fn(),owned=vi.fn();
    const jobs=new DeviceJobs({pool:{query},access:{claims},owned} as unknown as DeviceStore,{} as never,{} as never,{} as never,{} as never);
    let saved:{id:string;device_id:string;project_id:string|null;kind:string;state:string;payload:Record<string,unknown>},device:Device;
    beforeEach(()=>{
        vi.clearAllMocks();vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined);
        saved={id:'old-job',device_id:'computer',project_id:null,kind:'choose-root',state:'failed',payload:{}};
        device={id:'computer',email:actor.email,role:actor.activeRole,name:'QA',fingerprint:'fixture',last_seen:null,revoked:false,
            report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','project-rag-generations-v1'],bindings:[{projectId:'project',bindingId:binding,valid:true}]}};
        owned.mockImplementation(async()=>device);claims.mockResolvedValue({email:actor.email,userRoles:[actor.activeRole],projects:[{projectId:'project',projectName:'Project',role:actor.activeRole}]});
        query.mockImplementation(async(sql:string,args:unknown[])=>({rows:sql==='SELECT * FROM bridge_jobs WHERE id=$1 AND email=$2'&&args[1]===actor.email?[saved]:[],rowCount:sql==='SELECT 1 FROM projects WHERE id=$1'?1:0}));
        enqueue.mockResolvedValue({id:'new-job'});
    });
    const retry=()=>jobs.retry(actor,saved.id,requestKey);
    const projectJob=()=>{saved={...saved,kind:'sync-rag',project_id:'project',payload:{bindingId:binding}};};
    it('a healthy retry creates a new request through ordinary admission',async()=>{
        expect(await retry()).toEqual({id:'new-job'});expect(owned).toHaveBeenCalledWith(actor,'computer');
        expect(enqueue).toHaveBeenCalledWith(expect.anything(),expect.any(String),expect.objectContaining({requestKey,kind:'choose-root',deviceId:'computer',email:actor.email}),expect.any(Function));
    });
    it('account revocation after the original failure prevents retry',async()=>{
        claims.mockRejectedValue(new ForbiddenException('Отключено'));await expect(retry()).rejects.toMatchObject({status:403});expect(enqueue).not.toHaveBeenCalled();
    });
    it('a removed active role cannot reuse rights saved in a failed job',async()=>{
        claims.mockResolvedValue({email:actor.email,userRoles:[],projects:[]});await expect(retry()).rejects.toMatchObject({status:403});expect(enqueue).not.toHaveBeenCalled();
    });
    it('revoked project membership prevents retry before delivery',async()=>{
        projectJob();claims.mockResolvedValue({email:actor.email,userRoles:[actor.activeRole],projects:[]});await expect(retry()).rejects.toMatchObject({status:403});expect(enqueue).not.toHaveBeenCalled();
    });
    it('a changed project folder cannot redirect the retried action',async()=>{
        projectJob();expect(await retry()).toEqual({id:'new-job'});enqueue.mockClear();
        device.report.bindings=[{projectId:'project',bindingId:'b'.repeat(64),valid:true}];
        await expect(retry()).rejects.toThrow('Папка проекта изменилась');expect(enqueue).not.toHaveBeenCalled();
    });
    it('a deleted project cannot be resurrected by retry',async()=>{
        projectJob();query.mockImplementation(async(sql:string)=>({rows:sql==='SELECT * FROM bridge_jobs WHERE id=$1 AND email=$2'?[saved]:[],rowCount:0}));
        await expect(retry()).rejects.toMatchObject({status:404});expect(enqueue).not.toHaveBeenCalled();
    });
    it('a feature disabled after the old job fails prevents a new request',async()=>{
        projectJob();
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException({code:'feature-disabled'}));
        await expect(retry()).rejects.toMatchObject({status:403});expect(enqueue).not.toHaveBeenCalled();
    });
    it('workspace changes require a new wizard approval rather than replaying a preparation',async()=>{
        saved={...saved,kind:'bind-project',project_id:'project',payload:{mode:'transfer'}};
        await expect(retry()).rejects.toMatchObject({status:409});expect(owned).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();
    });
    it('an unfinished or successful job cannot start a second action',async()=>{
        for(const state of ['queued','running','reconciling','succeeded']){saved.state=state;await expect(retry()).rejects.toMatchObject({status:409});}
        expect(enqueue).not.toHaveBeenCalled();
    });
    it('another owner cannot discover or retry the historical job',async()=>{
        await expect(jobs.retry({...actor,email:'other@example.test'},saved.id,requestKey)).rejects.toMatchObject({status:404});expect(owned).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();
    });
    it('a revoked computer refuses retry even if account and project rights remain',async()=>{
        owned.mockRejectedValue(new ForbiddenException('Подключение отключено'));
        await expect(retry()).rejects.toMatchObject({status:403});expect(enqueue).not.toHaveBeenCalled();
    });
});
