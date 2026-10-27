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
import type {Request} from 'express';
import type {ModelsService} from '../src/models/models.service';
import type {ProjectChatInferenceService} from '../src/project-chat-inference/project-chat-inference.service';
import {ProjectChatService} from '../src/project-chat/project-chat.service';
import {DEFAULT_PROJECT_CHAT_ROOM} from '../src/project-chat/project-chat.types';
import {assertMethodChatOrigin,publishMethodChatResult} from '../src/agent-method-workflows/chat-origin';
import {assertMethodChatWorkflowsSchema} from '../src/agent-method-workflows/chat-workflows.schema-verification';
import {connection,database,reset,main,admin,developer} from './agent-postgres.fixture';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111';

describe.skipIf(!connection)('method workflow durable queue — owned PostgreSQL',()=>{
    let fixture:Awaited<ReturnType<typeof database>>,jobs:DeviceJobs,device:Device,chats:ProjectChatService,access:AccessDb;
    const request=(actor=admin)=>({headers:{'x-neurocenter-internal':'own-method-chat','x-bridge-actor':encodeURIComponent(JSON.stringify(actor))}} as unknown as Request);
    const infer=vi.fn(async()=>{throw Error('Method receipt must never dispatch chat inference');});
    const chatService=()=>new ProjectChatService({pool:fixture.pool,actor:async(req:Request)=>{const actor=JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'])));return {...actor,claims:await access.claims(actor.email)};}} as unknown as ModelsService,
        {roster:async()=>[],infer} as unknown as ProjectChatInferenceService);
    beforeAll(async()=>{fixture=await database();},60000);
    afterAll(async()=>fixture?.close());
    afterEach(async()=>{await chats?.onApplicationShutdown();vi.unstubAllGlobals();vi.unstubAllEnvs();});
    beforeEach(async()=>{
        await reset(fixture.pool);
        vi.mocked(requireFeaturesEnabled).mockResolvedValue(undefined);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','own-method-chat');infer.mockClear();
        device={id:'device-methods',email:admin.email,role:admin.activeRole,name:'QA',fingerprint:'fixture',last_seen:null,revoked:false,
            report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','workspace-instance-v1','project-agents-v2','agent-method-workflow-v1','agent-method-selected-agent-v1'],bindings:[{projectId:'prj-agents',bindingId,instanceId,valid:true}]}};
        await fixture.pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,$3,$4,$5,$6,$7)',[device.id,device.email,device.role,device.name,device.fingerprint,'method-fixture-token',device.report]);
        access=new AccessDb();Object.defineProperty(access,'pool',{value:fixture.pool});
        const store={pool:fixture.pool,access,owned:async(actor:{email:string},id:string)=>{if(actor.email!==device.email||id!==device.id)throw Error('not owned');return device;}} as unknown as DeviceStore;
        jobs=new DeviceJobs(store,{} as DeviceArtifacts,{} as DeviceInstallations,{} as InstallPlans,{} as ProjectEmbeddingService);
        chats=chatService();
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
    const linked=async(privateRoom=false)=>{
        const f=await selected(),roomId=privateRoom?(await chats.createRoom(request(main),'prj-agents',{requestKey:randomUUID(),title:'Own workflow room',visibility:'PRIVATE',memberEmails:[admin.email,developer.email]})).id:DEFAULT_PROJECT_CHAT_ROOM;
        const source=await chats.send(request(),'prj-agents',{requestKey:randomUUID(),prompt:'Published source task',targetAgentIds:[]},roomId);await chats.runner.waitIdle();
        return {...f,roomId,source,input:{...f.input,workflow:{...f.input.workflow,origin:{roomId,messageId:source.message.id}}}};
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
    it('returns the durable selected result in shared read/history after reload and OFF without chat inference',async()=>{
        const f=await linked(),queued=await jobs.create(admin,f.input),claimed=(await jobs.claim(device))!;
        expect(claimed.payload).not.toHaveProperty('origin');expect(claimed.payload).not.toHaveProperty('workflow');
        const accepted={lease:claimed.lease,state:'succeeded' as const,message:'PRIVATE RAW COMPLETION LOG',result:completion(claimed.payload)};
        await completeDeviceJob(fixture.pool,device.id,claimed.id,accepted);
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(Error('Feature OFF'));
        expect((await jobs.create(admin,f.input)).id).toBe(queued.id);expect(await completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).toMatchObject({repeated:true});
        const reloaded=chatService();try{
            for(const detail of [await reloaded.read(request(developer),'prj-agents',undefined,f.roomId),await reloaded.history(request(developer),'prj-agents',undefined,undefined,f.roomId)]){
                const card=detail.messages.find(row=>row.id===f.source.message.id)!.methodWorkflows![0];
                expect(card).toMatchObject({jobId:queued.id,workflowId:f.input.requestKey,publicationState:'published',state:'succeeded',result:{agent:{agentId:f.card.id},checks:[{state:'passed',exitCode:0}]},canCancel:false});
                for(const secret of ['PRIVATE RAW','owned-upstream','baseUrl','instruction','owner_email'])expect(JSON.stringify(card)).not.toContain(secret);
            }
        }finally{await reloaded.onApplicationShutdown();}
        expect(infer).not.toHaveBeenCalled();expect((await fixture.pool.query('SELECT count(*)::int AS count FROM project_chat_method_workflows')).rows[0].count).toBe(1);
    });
    it('rejects changing a stored origin under one key without creating another job/link or applying new gates',async()=>{
        const f=await linked(),queued=await jobs.create(admin,f.input),before=(await fixture.pool.query('SELECT count(*)::int AS count FROM bridge_jobs')).rows[0].count;
        vi.mocked(requireFeaturesEnabled).mockClear().mockRejectedValue(Error('Feature OFF'));
        await expect(jobs.create(admin,{...f.input,workflow:{...f.input.workflow,origin:{...f.input.workflow.origin,messageId:randomUUID()}}})).rejects.toMatchObject({status:409});
        expect((await jobs.create(admin,f.input)).id).toBe(queued.id);expect(requireFeaturesEnabled).not.toHaveBeenCalled();
        expect((await fixture.pool.query('SELECT count(*)::int AS count FROM bridge_jobs')).rows[0].count).toBe(before);
        expect((await fixture.pool.query('SELECT count(*)::int AS count FROM project_chat_method_workflows')).rows[0].count).toBe(1);
    });
    it('rejects cross-room/private origins before admission and rechecks private membership on polls',async()=>{
        const f=await linked(true);
        await expect(jobs.create(admin,{...f.input,workflow:{...f.input.workflow,origin:{roomId:DEFAULT_PROJECT_CHAT_ROOM,messageId:f.source.message.id}}})).rejects.toHaveProperty('status',404);
        await jobs.create(admin,f.input);const claimed=(await jobs.claim(device))!;
        await fixture.pool.query('DELETE FROM project_chat_room_members WHERE project_id=$1 AND room_id=$2 AND email=$3',['prj-agents',f.roomId,admin.email]);
        await expect(jobs.authorize(device,claimed.id,claimed.lease)).rejects.toHaveProperty('status',404);
        await expect(chats.read(request(),'prj-agents',undefined,f.roomId)).rejects.toHaveProperty('status',404);
    });
    it('keeps actual completion and ACK while withholding late publication after private access loss',async()=>{
        const f=await linked(true);await jobs.create(admin,f.input);const claimed=(await jobs.claim(device))!;
        await fixture.pool.query('DELETE FROM project_chat_room_members WHERE project_id=$1 AND room_id=$2 AND email=$3',['prj-agents',f.roomId,admin.email]);
        const accepted={lease:claimed.lease,state:'succeeded' as const,message:'RAW LOCAL ERROR/PATH',result:completion(claimed.payload)};
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).resolves.toMatchObject({ok:true});
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).resolves.toMatchObject({repeated:true});
        const detail=await chats.read(request(developer),'prj-agents',undefined,f.roomId),card=detail.messages.find(row=>row.id===f.source.message.id)!.methodWorkflows![0];
        expect(card).toMatchObject({state:'succeeded',publicationState:'withheld'});expect(card).not.toHaveProperty('result');expect(JSON.stringify(card)).not.toContain('RAW LOCAL');
        expect((await fixture.pool.query('SELECT result FROM bridge_jobs WHERE id=$1',[claimed.id])).rows[0].result).toEqual(accepted.result);
    });
    it.each(['running','reconciling'])('cancels %s methods at OFF after downgrade; polls stop and late success only receives ACK',async state=>{
        const f=await linked();await jobs.create(admin,f.input);const claimed=(await jobs.claim(device))!;
        if(state==='reconciling')await fixture.pool.query("UPDATE bridge_jobs SET state='reconciling' WHERE id=$1",[claimed.id]);
        await fixture.pool.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id='prj-agents' AND principal_name=$1",[admin.email]);
        const observer={email:admin.email,activeRole:'Наблюдатель'};vi.mocked(requireFeaturesEnabled).mockRejectedValue(Error('Feature OFF'));
        const before=await chats.read(request(observer),'prj-agents',undefined,f.roomId);expect(before.messages.find(row=>row.id===f.source.message.id)!.methodWorkflows![0].canCancel).toBe(true);
        await expect(jobs.cancel(observer,claimed.id)).resolves.toMatchObject({ok:true});await expect(jobs.cancel(observer,claimed.id)).resolves.toMatchObject({ok:true});
        await expect(jobs.authorize(device,claimed.id,claimed.lease)).rejects.toHaveProperty('status',409);
        const accepted={lease:claimed.lease,state:'succeeded' as const,message:'Late output',result:completion(claimed.payload)};
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).resolves.toMatchObject({ok:true,cancelled:true});
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).resolves.toMatchObject({repeated:true,cancelled:true});
        expect((await fixture.pool.query('SELECT state,result FROM bridge_jobs WHERE id=$1',[claimed.id])).rows[0]).toMatchObject({state:'cancelled',result:null});
    });
    it('accepts already observed completion after feature OFF while new linked admission and polls stop',async()=>{
        const f=await linked();await jobs.create(admin,f.input);const claimed=(await jobs.claim(device))!;
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(Error('Feature OFF'));
        await expect(jobs.authorize(device,claimed.id,claimed.lease)).rejects.toThrow('Feature OFF');
        await expect(jobs.create(admin,{...f.input,requestKey:randomUUID()})).rejects.toThrow('Feature OFF');
        vi.mocked(requireFeaturesEnabled).mockClear();
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,{lease:claimed.lease,state:'succeeded',message:'Observed before OFF',result:completion(claimed.payload)})).resolves.toMatchObject({ok:true});
        expect(requireFeaturesEnabled).not.toHaveBeenCalled();
        const detail=await chats.read(request(developer),'prj-agents',undefined,f.roomId);expect(detail.messages.find(row=>row.id===f.source.message.id)!.methodWorkflows![0]).toMatchObject({state:'succeeded',publicationState:'published'});
    });
    it('rolls back the queued job if private origin access changes after initial validation',async()=>{
        const f=await linked(true);let checks=0;
        vi.mocked(requireFeaturesEnabled).mockImplementation(async keys=>{if(keys.includes('project_agent_chat_workflows')&&++checks===2)
            await fixture.pool.query('DELETE FROM project_chat_room_members WHERE project_id=$1 AND room_id=$2 AND email=$3',['prj-agents',f.roomId,admin.email]);});
        await expect(jobs.create(admin,f.input)).rejects.toHaveProperty('status',404);
        expect((await fixture.pool.query("SELECT count(*)::int AS count FROM bridge_jobs WHERE kind='run-agent-method-workflow'")).rows[0].count).toBe(0);
        expect((await fixture.pool.query('SELECT count(*)::int AS count FROM project_chat_method_workflows')).rows[0].count).toBe(0);
    });
    it('locks a publication room for mutation without a share-to-update upgrade between concurrent jobs',async()=>{
        const f=await linked(),first=await jobs.create(admin,f.input),second=await jobs.create(admin,{...f.input,requestKey:randomUUID()}),one=await fixture.pool.connect(),two=await fixture.pool.connect();
        let reached!:()=>void;const attempting=new Promise<void>(resolve=>{reached=resolve;});
        const guarded={query:async(sql:string,args?:unknown[])=>{if(sql.includes('FROM project_chat_rooms'))reached();return two.query(sql,args);}} as unknown as typeof two;
        try{
            await one.query('BEGIN');await two.query('BEGIN');
            await assertMethodChatOrigin(one,'prj-agents',admin,f.input.workflow.origin,true,true);
            const pending=assertMethodChatOrigin(guarded,'prj-agents',admin,f.input.workflow.origin,true,true);
            await attempting;
            const job=(await one.query('SELECT * FROM bridge_jobs WHERE id=$1',[first.id])).rows[0];await publishMethodChatResult(one,job);await one.query('COMMIT');
            await pending;
            const other=(await two.query('SELECT * FROM bridge_jobs WHERE id=$1',[second.id])).rows[0];await publishMethodChatResult(two,other);await two.query('COMMIT');
            expect((await fixture.pool.query("SELECT count(*)::int AS count FROM project_chat_method_workflows WHERE publication_state='published'")).rows[0].count).toBe(2);
        }finally{await one.query('ROLLBACK');await two.query('ROLLBACK');one.release();two.release();}
    });
    it('keeps migration45 attribution immutable and refuses missing source FK/index/trigger at readiness',async()=>{
        const f=await linked();const queued=await jobs.create(admin,f.input);
        await expect(fixture.pool.query('UPDATE project_chat_method_workflows SET source_message_id=$2 WHERE job_id=$1',[queued.id,randomUUID()])).rejects.toMatchObject({code:'P0001'});
        for(const sql of ['DROP INDEX project_chat_method_source','ALTER TABLE project_chat_method_workflows DROP CONSTRAINT method_chat_source','DROP TRIGGER method_chat_origin_immutable ON project_chat_method_workflows']){
            const db=await fixture.pool.connect();try{await db.query('BEGIN');await db.query(sql);await expect(assertMethodChatWorkflowsSchema(db)).rejects.toThrow(/не готова/);}finally{await db.query('ROLLBACK');db.release();}
        }
        await expect(assertMethodChatWorkflowsSchema(fixture.pool)).resolves.toBeUndefined();
    });
    it('rejects direct API private check argv before queue/link insertion',async()=>{
        const f=await linked();
        for(const check of [null,{command:'node',args:['check.js','--token=PRIVATE','/Users/private/path']},{command:'npm',args:['test','--token=PRIVATE']}])
            await expect(jobs.create(admin,{...f.input,workflow:{...f.input.workflow,checks:[check] as never}})).rejects.toHaveProperty('status',400);
        expect((await fixture.pool.query("SELECT count(*)::int AS count FROM bridge_jobs WHERE kind='run-agent-method-workflow'")).rows[0].count).toBe(0);
        expect((await fixture.pool.query('SELECT count(*)::int AS count FROM project_chat_method_workflows')).rows[0].count).toBe(0);
    });
    it('paginates bounded receipts after OFF and rejects a cursor from another source without duplicates',async()=>{
        const f=await linked(true),ids:string[]=[];
        for(let index=0;index<10;index++)ids.push((await jobs.create(admin,{...f.input,requestKey:randomUUID()})).id);
        const another=await chats.send(request(),'prj-agents',{requestKey:randomUUID(),prompt:'Another published task'},f.roomId);await chats.runner.waitIdle();
        const foreign=await jobs.create(admin,{...f.input,requestKey:randomUUID(),workflow:{...f.input.workflow,origin:{roomId:f.roomId,messageId:another.message.id}}});
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(Error('Feature OFF'));
        const detail=await chats.read(request(developer),'prj-agents',undefined,f.roomId),source=detail.messages.find(row=>row.id===f.source.message.id)!;
        expect(source.methodWorkflows).toHaveLength(1);expect(source.methodWorkflowsHistory).toMatchObject({hasMore:true,nextCursor:ids.at(-1)});
        const page=await chats.methodWorkflows(request(developer),'prj-agents',source.id,source.methodWorkflowsHistory!.nextCursor!,undefined,f.roomId);
        expect(page.items).toHaveLength(8);expect(page.hasMore).toBe(true);
        const tail=await chats.methodWorkflows(request(developer),'prj-agents',source.id,page.nextCursor!,undefined,f.roomId);
        expect(tail.items).toHaveLength(1);expect(tail.hasMore).toBe(false);expect(tail.nextCursor).toBeNull();
        expect(new Set([...source.methodWorkflows!,...page.items,...tail.items].map(row=>row.jobId)).size).toBe(10);
        await expect(chats.methodWorkflows(request(developer),'prj-agents',source.id,foreign.id,undefined,f.roomId)).rejects.toHaveProperty('status',404);
        await expect(chats.methodWorkflows(request(developer),'prj-agents',source.id,undefined,'9',f.roomId)).rejects.toHaveProperty('status',400);
        await fixture.pool.query('DELETE FROM project_chat_room_members WHERE project_id=$1 AND room_id=$2 AND email=$3',['prj-agents',f.roomId,developer.email]);
        await expect(chats.methodWorkflows(request(developer),'prj-agents',source.id,undefined,undefined,f.roomId)).rejects.toHaveProperty('status',404);
    });
});
