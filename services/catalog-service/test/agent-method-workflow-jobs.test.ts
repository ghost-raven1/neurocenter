import {describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {Device} from '../src/devices/device-store';
import {agentMethodJobPayload,assertAgentMethodJob,assertAgentMethodResult,assertAgentMethodCompletionAccess} from '../src/agent-method-workflows/jobs';
import {requiredJobFeatures} from '../../shared/feature-policy.cjs';
import {jobMinimumLevel} from '../src/devices/device-job-access';

const bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111';
const input=()=>({deviceId:'device',projectId:'prj-qa',kind:'run-agent-method-workflow',requestKey:'22222222-2222-4222-8222-222222222222',expectedBindingId:bindingId,expectedInstanceId:instanceId,
    workflow:{method:'openspec' as const,instruction:'Исправить QA файл и проверить результат',checks:[{command:'npm',args:['test']}]}});
const device=():Device=>({id:'device',email:'qa@example.test',role:'Админ проекта',name:'QA',fingerprint:'qa',last_seen:null,revoked:false,
    report:{capabilities:['workspace-instance-v1','agent-method-workflow-v1'],bindings:[{projectId:'prj-qa',bindingId,instanceId,valid:true}]}});
const payload=()=>agentMethodJobPayload(device(),input())!;
const job=()=>({kind:'run-agent-method-workflow',project_id:'prj-qa',payload:{...payload()}});
const result=()=>({protocol:'agent-method-workflow-v1',workflowId:input().requestKey,method:'openspec',methodVersion:'1.15.0',runtime:'opencode',state:'succeeded',stage:'completed',codeChanged:true,
    changes:[{path:'src/qa.ts',beforeSha256:'a'.repeat(64),afterSha256:'b'.repeat(64)}],artifacts:[{path:'openspec/changes/qa/tasks.md',sha256:'c'.repeat(64)}],checks:[{command:'npm',args:['test'],exitCode:0,signal:null,state:'passed'}]});

describe('project method job authority',()=>{
    it('pins both method versions for the combined planning-to-change cycle',()=>{
        const saved=agentMethodJobPayload(device(),{...input(),workflow:{...input().workflow,method:'combined'}})!;
        expect(saved.method).toBe('combined');expect(saved.methodVersion).toBe('bmad-6.12.4+openspec-1.15.0');expect(saved.stage).toBe('full-cycle');
    });
    it('pins server method version and the exact selected folder without accepting browser runtime overrides',()=>{
        const saved=payload();expect(saved).toMatchObject({workflowId:input().requestKey,requestId:input().requestKey,methodVersion:'1.15.0',stage:'full-cycle',runtime:'opencode',bindingId,instanceId});
        expect(Date.parse(saved.deadlineAt)-Date.now()).toBeGreaterThan(29*60*1000);
        expect(()=>agentMethodJobPayload(device(),{...input(),runtime:'bash'} as never)).toThrow();
        expect(()=>agentMethodJobPayload(device(),{...input(),workflow:{...input().workflow,methodVersion:'latest'}} as never)).toThrow();
    });
    it('requires current instance, binding and executor capability before dispatch',()=>{
        expect(()=>agentMethodJobPayload(device(),{...input(),expectedInstanceId:'33333333-3333-4333-8333-333333333333'})).toThrow(/Папка/);
        expect(()=>assertAgentMethodJob({...device(),report:{...device().report,capabilities:['workspace-instance-v1']}},job())).toThrow();
        expect(()=>assertAgentMethodJob(device(),{...job(),project_id:'another'})).toThrow();
    });
    it('rejects malformed checks and keeps execution separate from historical reads',()=>{
        expect(()=>agentMethodJobPayload(device(),{...input(),workflow:{...input().workflow,checks:[{command:'npm;echo',args:[]}]}})).toThrow();
        expect(requiredJobFeatures(input().kind)).toEqual(['agent_method_workflows']);
        expect(requiredJobFeatures('uninstall')).toEqual([]);
        expect(jobMinimumLevel(input().kind)).toBe(3);
    });
    it('never promotes failed or unexecuted checks to successful workflow completion',()=>{
        expect(()=>assertAgentMethodResult(job(),result(),false)).not.toThrow();
        expect(()=>assertAgentMethodResult(job(),{...result(),checks:[{...result().checks[0],state:'failed',exitCode:1}]},false)).toThrow();
        expect(()=>assertAgentMethodResult(job(),{...result(),workflowId:'33333333-3333-4333-8333-333333333333'},false)).toThrow();
        expect(()=>assertAgentMethodResult(job(),result(),true)).toThrow();
    });
    it('rechecks fresh user and device grants and binding when accepting a late success',async()=>{
        const current=device(),query=vi.fn(async(sql:string)=>({rows:sql.includes('bridge_devices')?[current]:sql.includes('platform_users')?[{enabled:true,is_main_admin:false}]:[{role:'Админ проекта'}]}));
        const db={query} as unknown as PoolClient,accepted={...job(),device_id:current.id,email:current.email,role:current.role};
        await expect(assertAgentMethodCompletionAccess(db,accepted)).resolves.toBeUndefined();
        current.role='Разработчик';await expect(assertAgentMethodCompletionAccess(db,accepted)).rejects.toThrow(/отозван/);
        current.role='Админ проекта';current.report.bindings=[{projectId:'prj-qa',bindingId:'b'.repeat(64),instanceId}];
        await expect(assertAgentMethodCompletionAccess(db,accepted)).rejects.toThrow(/Папка/);
    });
});
