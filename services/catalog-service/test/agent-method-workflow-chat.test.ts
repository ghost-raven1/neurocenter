import {describe,expect,it,vi,beforeEach} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {methodChatOrigin,assertMethodChatOrigin,assertMethodChatJob,publishMethodChatResult} from '../src/agent-method-workflows/chat-origin';
import {projectChatMethodWorkflows} from '../src/agent-method-workflows/chat-workflows';
import {completeDeviceJob} from '../src/devices/device-completion';
import {normalizeAgentMethodWorkflowPayload,agentMethodWorkflowAgentIdentity} from '../../shared/agent-method-workflow.cjs';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import type {JobInput} from '../src/devices/device-job.model';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const roomId='11111111-1111-4111-8111-111111111111',messageId='22222222-2222-4222-8222-222222222222',workflowId='33333333-3333-4333-8333-333333333333';
const actor={email:'owner@fixture.test',activeRole:'Админ проекта',level:3,displayName:'Owner',writable:true};
const origin={roomId,messageId},identity={agentId:'agent-owned',slug:'nc-owned',version:1,agentsRevision:2,agentsManifestSha256:'a'.repeat(64),compiledManifestSha256:'b'.repeat(64),fileSha256:'c'.repeat(64),configurationJobId:'44444444-4444-4444-8444-444444444444'};
const payload=()=>normalizeAgentMethodWorkflowPayload({protocol:'agent-method-workflow-v1',workflowId,requestId:workflowId,projectId:'prj-owned',bindingId:'a'.repeat(64),instanceId:roomId,
    method:'openspec',methodVersion:'1.15.0',runtime:'opencode',stage:'full-cycle',deadlineAt:'2026-10-27T12:00:00.000Z',instruction:'Private source task',checks:[{command:'npm',args:['test']}],
    agent:{...identity,mode:'primary',model:{agentId:'agent-owned',provider:'owned',configKey:'owned',runtime:'remote-openai',model:'private-upstream',baseUrl:'http://127.0.0.1:19091/v1',options:{temperature:0},capability:'chat'}}});
const result=()=>({protocol:'agent-method-workflow-v1',workflowId,method:'openspec',methodVersion:'1.15.0',runtime:'opencode',state:'succeeded',stage:'completed',codeChanged:true,
    changes:[{path:'src/owned.ts',beforeSha256:null,afterSha256:'d'.repeat(64)}],artifacts:[],checks:[{command:'npm',args:['test'],exitCode:0,signal:null,state:'passed'}],agent:identity});
const input=():JobInput=>({kind:'run-agent-method-workflow',deviceId:'device-owned',projectId:'prj-owned',requestKey:workflowId,
    workflow:{method:'openspec',instruction:'Own task',checks:[{command:'npm',args:['test']}],agentId:'agent-owned',expectedAgentsRevision:2,origin}});

function fixture(){
    const state={enabled:true,member:true,privateMember:true,sourceKind:'user',publication:'pending',publicResult:null as unknown,link:true,io:false};
    const link=()=>({job_id:'job-owned',project_id:'prj-owned',room_id:roomId,source_message_id:messageId,owner_email:actor.email,owner_role:actor.activeRole,publication_state:state.publication});
    const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
        if(state.io)throw Error('database unavailable');
        let rows:unknown[]=[];
        if(sql.includes('FROM platform_users'))rows=[{enabled:state.enabled,is_main_admin:false,display_name:'Owner'}];
        else if(sql.includes('FROM project_members'))rows=state.member?[{project_id:'prj-owned',role:actor.activeRole}]:[];
        else if(sql.includes('FROM projects'))rows=[{state:'ACTIVE'}];
        else if(sql.includes('FROM project_chat_rooms'))rows=[{id:roomId,project_id:'prj-owned',visibility:'PRIVATE',creator_email:'another@fixture.test'}];
        else if(sql.includes('FROM project_chat_room_members'))rows=state.privateMember?[{email:actor.email}]:[];
        else if(sql.includes('FROM project_chat_messages'))rows=[{kind:state.sourceKind}];
        else if(sql.includes('JOIN bridge_jobs'))rows=state.link?[{...link(),id:'job-owned',email:actor.email,payload:payload(),state:'succeeded',percent:100,
            created_at:new Date(0),started_at:null,updated_at:new Date(1),public_result:state.publicResult,message:'/private/log SECRET',result:result()}]:[];
        else if(sql.startsWith('SELECT * FROM project_chat_method_workflows'))rows=state.link?[link()]:[];
        else if(sql.startsWith('UPDATE project_chat_method_workflows')){state.publication=String(args[1]);state.publicResult=args[2];}
        return {rows,rowCount:rows.length};
    });
    const db={query} as unknown as PoolClient;
    const job={id:'job-owned',kind:'run-agent-method-workflow',project_id:'prj-owned',email:actor.email,role:actor.activeRole,payload:{...payload()}};
    return {state,db,query,job};
}

beforeEach(()=>vi.mocked(requireFeaturesEnabled).mockClear().mockResolvedValue(undefined));
describe('durable source-chat method receipts',()=>{
    it('requires an explicit selected agent and exactly two valid origin identifiers',()=>{
        expect(methodChatOrigin(input())).toEqual(origin);
        const legacy=input();delete legacy.workflow!.origin;expect(methodChatOrigin(legacy)).toBeUndefined();
    });
    it.each([null,{}, {roomId,messageId,projectId:'forged'}, {roomId:'wrong',messageId}])('rejects a malformed origin: %j',raw=>{
        expect(()=>methodChatOrigin({...input(),workflow:{...input().workflow!,origin:raw} as never})).toThrow();
    });
    it('rejects legacy origin rather than silently using a default executor',()=>{
        expect(()=>methodChatOrigin({...input(),workflow:{method:'openspec',instruction:'Own task',checks:[],origin}})).toThrow();
    });
    it.each([{command:'node',args:['check.js','--token=PRIVATE','/Users/private/path']},{command:'npm',args:['test','--token=PRIVATE']}])('rejects private argv in shared-origin admission: %j',check=>{
        expect(()=>methodChatOrigin({...input(),workflow:{...input().workflow!,checks:[check]}})).toThrow(/npm test/);
    });
    it('returns a user validation error for a null JSON check instead of throwing a TypeError',()=>{
        expect(()=>methodChatOrigin({...input(),workflow:{...input().workflow!,checks:[null] as never}})).toThrow(expect.objectContaining({status:400}));
    });
    it('authorizes the original private room and stored user message',async()=>{
        const f=fixture();await expect(assertMethodChatOrigin(f.db,'prj-owned',actor,origin)).resolves.toBeUndefined();
        f.state.privateMember=false;await expect(assertMethodChatOrigin(f.db,'prj-owned',actor,origin)).rejects.toHaveProperty('status',404);
        f.state.privateMember=true;f.state.sourceKind='agent';await expect(assertMethodChatOrigin(f.db,'prj-owned',actor,origin)).rejects.toHaveProperty('status',404);
    });
    it('keeps the origin outside legacy execution and stops linked polls when its feature is OFF',async()=>{
        const f=fixture();f.state.link=false;await expect(assertMethodChatJob(f.db,f.job)).resolves.toBeUndefined();expect(requireFeaturesEnabled).not.toHaveBeenCalled();
        f.state.link=true;vi.mocked(requireFeaturesEnabled).mockRejectedValueOnce(Error('feature OFF'));
        await expect(assertMethodChatJob(f.db,f.job)).rejects.toThrow('feature OFF');
    });
    it('publishes a normalized result without checking feature flags and never replaces it on replay',async()=>{
        const f=fixture();await publishMethodChatResult(f.db,f.job,result());
        expect(f.state.publication).toBe('published');expect(f.state.publicResult).toMatchObject({agent:identity,state:'succeeded'});expect(requireFeaturesEnabled).not.toHaveBeenCalled();
        f.state.privateMember=false;await publishMethodChatResult(f.db,f.job,result());expect(f.state.publication).toBe('published');
        expect(f.query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE project_chat_method_workflows'))).toHaveLength(1);
    });
    it('withholds late shared details after private access loss without rejecting the observed outcome',async()=>{
        const f=fixture();f.state.privateMember=false;
        await expect(publishMethodChatResult(f.db,f.job,result())).resolves.toBeUndefined();
        expect(f.state.publication).toBe('withheld');expect(f.state.publicResult).toBeNull();
    });
    it('does not disguise a database failure as a successful withheld publication',async()=>{
        const f=fixture();f.state.io=true;await expect(publishMethodChatResult(f.db,f.job,result())).rejects.toThrow('database unavailable');
    });
    it('shares only the accepted public identity/result and keeps cancellation owned',async()=>{
        const f=fixture();await publishMethodChatResult(f.db,f.job,result());
        const cards=(await projectChatMethodWorkflows(f.db,'prj-owned',roomId,[messageId],actor)).get(messageId)!.items;
        expect(cards[0]).toMatchObject({agent:agentMethodWorkflowAgentIdentity(payload().agent),result:{state:'succeeded'},publicationState:'published',canCancel:false});
        for(const secret of ['Private source task','private-upstream','baseUrl','SECRET','owner@fixture.test'])expect(JSON.stringify(cards)).not.toContain(secret);
        f.state.publication='withheld';f.state.publicResult=result();
        const hidden=(await projectChatMethodWorkflows(f.db,'prj-owned',roomId,[messageId],{...actor,email:'reader@fixture.test'})).get(messageId)!.items;
        expect(hidden[0]).not.toHaveProperty('result');expect(hidden[0].canCancel).toBe(false);
    });
    it('acknowledges a stopped runtime without replacing cancellation with a late success',async()=>{
        const f=fixture(),cancelled={...f.job,state:'cancelled',device_id:'device-owned',lease_until:new Date(0),result:null};
        const query=vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT * FROM bridge_jobs')?[cancelled]:[]})),release=vi.fn();
        const pool={connect:async()=>({query,release})} as unknown as Pool;
        await expect(completeDeviceJob(pool,'device-owned','job-owned',{lease:'same-owned-lease',state:'succeeded',message:'untrusted',result:result()})).resolves.toEqual({ok:true,repeated:true,cancelled:true});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE bridge_jobs'))).toBe(false);expect(release).toHaveBeenCalledOnce();
    });
});
