import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {AccessDb} from '../src/access/access-db';
import {DeviceJobs} from '../src/devices/device-jobs';
import {completeDeviceJob} from '../src/devices/device-completion';
import {AgentRepository} from '../src/agents/agent.repository';
import {ProjectAgentRepository} from '../src/agents/project-agent.repository';
import {assertAgentMethodCompletionAccess} from '../src/agent-method-workflows/jobs';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {PROJECT_AGENTS_NOTE,type ProjectAgentsPayload} from '../../shared/project-agents.cjs';
import {agentMethodWorkflowAgentIdentity} from '../../shared/agent-method-workflow.cjs';
import type {Device,DeviceStore} from '../src/devices/device-store';
import type {DeviceArtifacts} from '../src/devices/device-artifacts';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';
import type {ProjectEmbeddingService} from '../src/models/project-embedding.service';
import {connection,database,reset,main,admin,developer} from './agent-postgres.fixture';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111';

describe.skipIf(!connection)('method workflow durable queue — owned PostgreSQL',()=>{
    let fixture:Awaited<ReturnType<typeof database>>,jobs:DeviceJobs,device:Device;
    beforeAll(async()=>{fixture=await database();},60000);
    afterAll(async()=>fixture?.close());
    afterEach(()=>vi.unstubAllGlobals());
    beforeEach(async()=>{
        await reset(fixture.pool);
        vi.mocked(requireFeaturesEnabled).mockResolvedValue(undefined);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
        device={id:'device-methods',email:admin.email,role:admin.activeRole,name:'QA',fingerprint:'fixture',last_seen:null,revoked:false,
            report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','workspace-instance-v1','project-agents-v2','agent-method-workflow-v1','agent-method-selected-agent-v1'],bindings:[{projectId:'prj-agents',bindingId,instanceId,valid:true}]}};
        await fixture.pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,$3,$4,$5,$6,$7)',[device.id,device.email,device.role,device.name,device.fingerprint,'method-fixture-token',device.report]);
        const access=new AccessDb();Object.defineProperty(access,'pool',{value:fixture.pool});
        const store={pool:fixture.pool,access,owned:async(actor:{email:string},id:string)=>{if(actor.email!==device.email||id!==device.id)throw Error('not owned');return device;}} as unknown as DeviceStore;
        jobs=new DeviceJobs(store,{} as DeviceArtifacts,{} as DeviceInstallations,{} as InstallPlans,{} as ProjectEmbeddingService);
    });
    const intent=()=>({kind:'run-agent-method-workflow',projectId:'prj-agents',deviceId:device.id,requestKey:randomUUID(),expectedBindingId:bindingId,expectedInstanceId:instanceId,
        workflow:{method:'openspec' as const,instruction:'QA fixture task',checks:[{command:'npm',args:['test']}]}});
    const completion=(payload:Record<string,unknown>)=>({protocol:'agent-method-workflow-v1',workflowId:payload.workflowId,method:payload.method,methodVersion:payload.methodVersion,runtime:'opencode',state:'succeeded',stage:'completed',codeChanged:true,
        changes:[{path:'src/qa.ts',beforeSha256:'a'.repeat(64),afterSha256:'b'.repeat(64)}],artifacts:[],checks:[{command:'npm',args:['test'],exitCode:0,signal:null,state:'passed'}],...(payload.agent?{agent:agentMethodWorkflowAgentIdentity(payload.agent)}:{})});
    const selected=async()=>{
        const modelId='model-method-'+randomUUID(),semantic='d'.repeat(64);
        await fixture.pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3)',[modelId,modelId,{description:'QA',runtime:'remote-openai',model:'owned-upstream',modelVersion:'v1',capability:'chat',dimension:null,source:'custom',manifestSha256:null,verificationSha256:semantic}]);
        await fixture.pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)',['prj-agents',modelId,admin.email]);
        await fixture.pool.query("INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,options,semantic_sha,verified_at) VALUES($1,1,$2,false,'none',$3,$4,now())",[modelId,'http://127.0.0.1:19091/v1',{temperature:0},semantic]);
        const card=await new AgentRepository(fixture.pool).create(main,{requestKey:randomUUID(),slug:'nc-method-owned',name:'Owned method agent',definition:{description:'QA',prompt:'Implement the owned accepted task.',mode:'primary',permission:{read:'allow',edit:'allow',bash:'allow'},model:'neurocenter/'+modelId}});
        const projects=new ProjectAgentRepository(fixture.pool);
        await projects.assign(admin,'prj-agents',{requestKey:randomUUID(),expectedRevision:0,agentId:card.id,version:card.version,manifest:card.manifest});
        await projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,enabled:true});
        const configuration={kind:'configure-project-agents',projectId:'prj-agents',deviceId:device.id,requestKey:randomUUID(),expectedAgentsRevision:2,expectedBindingId:bindingId,expectedInstanceId:instanceId};
        await jobs.create(admin,configuration);const applied=(await jobs.claim(device))!;
        applied.payload.compilation=await jobs.compileAgents(device,{jobId:applied.id,lease:applied.lease,payloadManifest:applied.payload.manifestSha256,
            mappings:[{agentId:card.id,provider:'owned',configKey:'native-alias',runtime:'remote-openai',model:'owned-upstream',baseUrl:'http://127.0.0.1:19091/v1',options:{temperature:0},capability:'chat'}]});
        const payload=applied.payload as unknown as ProjectAgentsPayload;
        await completeDeviceJob(fixture.pool,device.id,applied.id,{lease:applied.lease,state:'succeeded',message:'QA configuration',result:{schemaVersion:2,projectId:payload.projectId,bindingId,instanceId,revision:payload.revision,manifestSha256:payload.manifestSha256,
            compiledManifestSha256:payload.compilation!.manifestSha256,agents:payload.compilation!.agents,changed:true,readiness:'configured',checkedAt:new Date().toISOString(),note:PROJECT_AGENTS_NOTE}});
        const input=intent();return {card,modelId,projects,configuration,applied,input:{...input,workflow:{...input.workflow,agentId:card.id,expectedAgentsRevision:2}}};
    };

    it('accepts one immutable intent, preserves enqueue/completion ACK and records one durable job',async()=>{
        const input=intent(),first=await jobs.create(admin,input),again=await jobs.create(admin,input);expect(again.id).toBe(first.id);expect(first.workflowId).toBe(input.requestKey);
        await expect(jobs.create(admin,{...input,workflow:{...input.workflow,instruction:'Different intent'}})).rejects.toThrow(/Ключ/);
        const claimed=(await jobs.claim(device))!;expect(claimed.id).toBe(first.id);expect(claimed.payload).toMatchObject({workflowId:input.requestKey,bindingId,instanceId,methodVersion:'1.15.0'});
        const accepted={lease:claimed.lease,state:'succeeded' as const,message:'QA complete',result:completion(claimed.payload)};
        expect(await completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).toMatchObject({ok:true});
        expect(await completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).toMatchObject({ok:true,repeated:true});
        expect((await fixture.pool.query('SELECT state,result FROM bridge_jobs WHERE id=$1',[claimed.id])).rows[0]).toMatchObject({state:'succeeded',result:accepted.result});
        expect((await fixture.pool.query('SELECT count(*)::int AS count FROM bridge_jobs')).rows[0].count).toBe(1);
    },15000);

    it('rejects developer execution and an unrelated instance before queue admission',async()=>{
        await expect(jobs.create(developer,intent())).rejects.toThrow();
        await expect(jobs.create(admin,{...intent(),expectedInstanceId:randomUUID()})).rejects.toThrow(/Папка/);
        expect((await fixture.pool.query('SELECT count(*)::int AS count FROM bridge_jobs')).rows[0].count).toBe(0);
    });

    it('cannot accept a stale binding or revoked grant as successful completion',async()=>{
        await jobs.create(admin,intent());const claimed=(await jobs.claim(device))!;
        const accepted={lease:claimed.lease,state:'succeeded' as const,message:'QA complete',result:completion(claimed.payload)};
        await fixture.pool.query("UPDATE bridge_devices SET report=jsonb_set(report,'{bindings,0,instanceId}',to_jsonb($2::text)) WHERE id=$1",[device.id,randomUUID()]);
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).rejects.toThrow(/Папка/);
        await fixture.pool.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[device.id,device.report]);
        await fixture.pool.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id='prj-agents' AND principal_name=$1",[admin.email]);
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).rejects.toThrow(/отозван/);
        expect((await fixture.pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[claimed.id])).rows[0].state).toBe('running');
    });

    it('runs the approved selected identity through queue, authorization and durable completion replay',async()=>{
        const f=await selected(),queued=await jobs.create(admin,f.input),claimed=(await jobs.claim(device))!;
        expect(claimed.id).toBe(queued.id);expect(claimed.payload.agent).toMatchObject({agentId:f.card.id,slug:f.card.slug,agentsRevision:2,configurationJobId:f.applied.id,model:{provider:'owned',configKey:'native-alias'}});
        await jobs.authorize(device,claimed.id,claimed.lease);
        const accepted={lease:claimed.lease,state:'succeeded' as const,message:'QA selected agent complete',result:completion(claimed.payload)};
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).resolves.toMatchObject({ok:true});
        await f.projects.update(admin,'prj-agents',f.card.id,{requestKey:randomUUID(),expectedRevision:2,enabled:false});
        expect((await jobs.create(admin,f.input)).id).toBe(queued.id);
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).resolves.toMatchObject({ok:true,repeated:true});
    });
    it('does not claim an accepted selected job after desired profile edits, while exact enqueue recovery remains readable',async()=>{
        const f=await selected(),queued=await jobs.create(admin,f.input);
        await f.projects.update(admin,'prj-agents',f.card.id,{requestKey:randomUUID(),expectedRevision:2,overrides:{prompt:'A different accepted profile'}});
        expect(await jobs.claim(device)).toBeNull();expect((await jobs.create(admin,f.input)).id).toBe(queued.id);
        expect((await fixture.pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[queued.id])).rows[0].state).toBe('failed');
    });
    it('revoked model access stops a running selected job and rejects its late success',async()=>{
        const f=await selected();await jobs.create(admin,f.input);const claimed=(await jobs.claim(device))!;
        await fixture.pool.query('DELETE FROM project_models WHERE project_id=$1 AND model_id=$2',['prj-agents',f.modelId]);
        await expect(jobs.authorize(device,claimed.id,claimed.lease)).rejects.toMatchObject({status:409});
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,{lease:claimed.lease,state:'succeeded',message:'QA',result:completion(claimed.payload)})).rejects.toMatchObject({status:409});
        expect((await fixture.pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[claimed.id])).rows[0].state).toBe('running');
    });
    it('a newer configuration intent shadows historical success instead of authorizing the old profile',async()=>{
        const f=await selected();await jobs.create(admin,f.input);const claimed=(await jobs.claim(device))!;
        await jobs.create(admin,{...f.configuration,requestKey:randomUUID()});
        await expect(jobs.authorize(device,claimed.id,claimed.lease)).rejects.toMatchObject({status:409});
        await expect(jobs.create(admin,{...f.input,requestKey:randomUUID()})).rejects.toMatchObject({status:409});
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,{lease:claimed.lease,state:'succeeded',message:'QA',result:completion(claimed.payload)})).rejects.toMatchObject({status:409});
    });
    it('rechecks selected desired state inside final enqueue admission, after the initial snapshot',async()=>{
        const f=await selected();let selectedChecks=0;
        vi.mocked(requireFeaturesEnabled).mockImplementation(async keys=>{
            if(keys.includes('project_agent_workflows')&&++selectedChecks===2)await f.projects.update(admin,'prj-agents',f.card.id,{requestKey:randomUUID(),expectedRevision:2,overrides:{prompt:'Changed before enqueue permit'}});
        });
        await expect(jobs.create(admin,f.input)).rejects.toMatchObject({status:409});
        expect((await fixture.pool.query("SELECT 1 FROM bridge_jobs WHERE kind='run-agent-method-workflow'")).rowCount).toBe(0);
    });
    it('holds desired-set and exact model rows through successful completion admission',async()=>{
        const f=await selected();await jobs.create(admin,f.input);const claimed=(await jobs.claim(device))!,owner=await fixture.pool.connect(),other=await fixture.pool.connect();
        try{
            await owner.query('BEGIN');await assertAgentMethodCompletionAccess(owner,{...claimed,email:device.email,role:device.role});
            for(const [sql,args]of [["SELECT revision FROM project_agent_sets WHERE project_id=$1 FOR UPDATE NOWAIT",['prj-agents']],['SELECT id FROM model_catalog WHERE id=$1 FOR UPDATE NOWAIT',[f.modelId]],
                ['SELECT model_id FROM project_models WHERE project_id=$1 AND model_id=$2 FOR UPDATE NOWAIT',['prj-agents',f.modelId]],
                ['SELECT model_id FROM model_remote_connections WHERE model_id=$1 FOR UPDATE NOWAIT',[f.modelId]],['SELECT id FROM agent_catalog WHERE id=$1 FOR UPDATE NOWAIT',[f.card.id]]] as const){
                await other.query('BEGIN');await expect(other.query(sql,[...args])).rejects.toMatchObject({code:'55P03'});await other.query('ROLLBACK');
            }
            await owner.query('COMMIT');
        }finally{await owner.query('ROLLBACK');await other.query('ROLLBACK');owner.release();other.release();}
    });
});
