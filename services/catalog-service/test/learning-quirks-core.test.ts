import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {buildPackage,type IPackage} from '../src/catalog/bundle-package';
import type {DeviceStore,Device} from '../src/devices/device-store';
import {DeviceInstallations} from '../src/devices/device-installations';
import {InstallPlans} from '../src/devices/install-plans';
import type {DeviceArtifacts} from '../src/devices/device-artifacts';
import type {Job,JobInput} from '../src/devices/device-job.model';
import {LearningRepository} from '../src/learning/learning.repository';
import type {LearningService} from '../src/learning/learning.service';
import {LearningQuirksService} from '../src/learning-quirks/learning-quirks.service';
import {assertQuirksJob,quirksJobPayload,LEARNING_QUIRKS_KIND} from '../src/learning-quirks/learning-quirks-jobs';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {QUIRKS_SOURCE_SHA256} from '../../shared/project-learning-quirks.cjs';

const projectId='prj-quirks-core',bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111';
const planId='44444444-4444-4444-8444-444444444444';
const quirk={id:'quirk:55555555-5555-4555-8555-555555555555',content:'Reported engine observation',tags:['fixture'],confidence:0.99,lastObserved:'2026-10-24T00:00:00.000Z'};
const otherQuirk={...quirk,id:'quirk:66666666-6666-4666-8666-666666666666'};
const ragCore={schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs'};
const hostedEmbedding={schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1};
const localUi={...ragCore,args:['ui','--port','0','--no-open']};
const learningQuirks={schemaVersion:1,format:'opencode-rag-quirks-jsonl',sourceSha256:QUIRKS_SOURCE_SHA256};

/** Self-verified engine bytes pass the actual installation and approval owners. */
function enginePackage(extra:Record<string,unknown>={ragCore,hostedEmbedding,learningQuirks}):IPackage{
    return buildPackage({id:'rag-core',name:'OpenCodeRAG',kind:'plugin',version:12},[],'2026-10-24T00:00:00.000Z',{
        entrypoint:'rag-plugin.mjs',extra:{runtimeArtifacts:[{target:'darwin-arm64',sha256:'b'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:2,entrypoint:'rag-plugin.mjs'}],...extra}});
}

/** Controlled transport invokes real authority owners; no Pool, bootstrap, HTTP listener or internal authority mock. */
function fixture(pkg=enginePackage(),uiCapability=false){
    const state={enabled:true,approval:'approved',planRevision:1,role:'Разработчик',installed:pkg,afterFirstCommit:undefined as (()=>void)|undefined,revision:0};
    const device={id:'device-core-fixture',email:'dev@quirks.fixture',role:state.role,report:{protocolVersion:2,
        capabilities:['workspace-instance-v1','hosted-rag-core-v1','project-learning-quirks-v1','package-v5',...(uiCapability?['opencode-rag-ui-v1']:[])],
        bindings:[{projectId,bindingId,instanceId,valid:true}]}} as unknown as Device;
    const actor={email:device.email,activeRole:device.role};
    const experiences=new Map<string,{projectId:string;data:Record<string,unknown>}>(),receipts=new Map<string,unknown>(),history:Array<Record<string,unknown>>=[];
    let job:Job;
    const plan=()=>({id:planId,project_id:projectId,asset_kind:pkg.plugin.kind,asset_id:pkg.plugin.id,version:pkg.plugin.version,
        manifest:pkg.manifest.sha256,package:pkg,status:state.approval,revision:state.planRevision,installation_set:null});
    const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
        if(sql.startsWith('BEGIN')||sql==='ROLLBACK'||sql.includes('pg_advisory_xact_lock'))return {rows:[]};
        if(sql==='COMMIT'){
            if(experiences.size===1&&state.afterFirstCommit){const action=state.afterFirstCommit;state.afterFirstCommit=undefined;action();}
            return {rows:[]};
        }
        if(sql.includes('SELECT installed_action AS kind,jsonb_set'))return {rows:args.join('|')===[device.email,device.id,projectId,pkg.plugin.id,pkg.plugin.kind,bindingId].join('|')?[{kind:'install',payload:{package:state.installed,bindingId}}]:[]};
        if(sql.includes('FROM device_install_plans')){
            const selected=sql.includes("status='approved'")?args.join('|')===[projectId,pkg.plugin.kind,pkg.plugin.id,pkg.plugin.version,pkg.manifest.sha256].join('|')&&state.approval==='approved':args[0]===planId;
            return {rows:selected?[plan()]:[]};
        }
        if(sql.includes('FROM project_assets'))return {rows:args.join('|')===[projectId,pkg.plugin.kind,pkg.plugin.id].join('|')?[{project_id:projectId,asset_id:pkg.plugin.id,asset_kind:pkg.plugin.kind,
            asset_version:pkg.plugin.version,asset_manifest:pkg.manifest.sha256,pin_snapshot:{package:pkg},pin_origin:'catalog'}]:[]};
        if(sql.includes('FROM projects'))return {rows:[{id:projectId}]};
        if(sql.includes('FROM project_retirements'))return {rows:[]};
        if(sql.includes('FROM platform_users'))return {rows:[{enabled:true,is_main_admin:false}]};
        if(sql.includes('FROM project_members'))return {rows:[{role:state.role}]};
        if(sql.includes('FROM bridge_devices'))return {rows:args[0]===device.id&&args[1]===device.email?[device]:[]};
        if(sql.startsWith('SELECT * FROM bridge_jobs'))return {rows:job?.state==='running'&&args.join('|')===[job.id,device.id,device.email,device.role,projectId,LEARNING_QUIRKS_KIND,job.lease].join('|')?[job]:[]};
        if(sql.includes('SELECT request_hash,result FROM project_learning_requests'))return {rows:receipts.has(String(args[1]))?[receipts.get(String(args[1]))]:[]};
        if(sql.includes('INSERT INTO project_learning_state'))return {rows:[]};
        if(sql.includes('SELECT revision FROM project_learning_state'))return {rows:[{revision:String(state.revision)}]};
        if(sql.includes('UPDATE project_learning_state')){state.revision=Number(args[1]);return {rows:[]};}
        if(sql.includes('SELECT id FROM project_learning_experiences')){
            if(sql.includes('id=ANY'))return {rows:(args[1] as string[]).filter(id=>experiences.get(id)?.projectId===args[0]).map(id=>({id}))};
            return {rows:experiences.get(String(args[0]))?.projectId===args[1]?[{id:args[0]}]:[]};
        }
        if(sql.includes('INSERT INTO project_learning_experiences')){
            const id=String(args[0]);if(experiences.has(id))return {rows:[]};
            experiences.set(id,{projectId:String(args[1]),data:JSON.parse(String(args[2]))});return {rows:[{id}]};
        }
        if(sql.includes('INSERT INTO project_learning_requests')){receipts.set(String(args[1]),{request_hash:args[3],result:JSON.parse(String(args[4]))});return {rows:[]};}
        if(sql.includes('INSERT INTO project_learning_history')){
            history.push({id:args[0],project_id:args[1],revision:args[2],action:args[3],resource_id:args[4],actor:args[5],details:JSON.parse(String(args[6])),created_at:'2026-10-24T00:00:00.000Z'});return {rows:[]};
        }
        if(sql.includes('FROM project_learning_history'))return {rows:[...history].reverse()};
        if(sql.includes('INSERT INTO security_events'))return {rows:[]};
        throw new Error('Unhandled controlled query: '+sql);
    });
    const db={query,release:vi.fn()},pool={query,connect:async()=>db} as unknown as Pool;
    const store={pool,owned:async()=>device,access:{claims:async()=>({email:device.email,userRoles:[device.role],projects:[{projectId,role:state.role}]})}} as unknown as DeviceStore;
    const installations=new DeviceInstallations(store),plans=new InstallPlans(store,{} as DeviceArtifacts),owners={store,installations,plans};
    const repository=new LearningRepository(pool),service=new LearningQuirksService(store,installations,plans,{repository} as LearningService);
    const input:JobInput={deviceId:device.id,projectId,kind:LEARNING_QUIRKS_KIND,requestKey:'core-quirks-fixture',assetId:pkg.plugin.id,assetKind:pkg.plugin.kind,version:pkg.plugin.version,
        expectedManifest:pkg.manifest.sha256,expectedBindingId:bindingId,expectedInstanceId:instanceId,expectedConfigurationRevisions:[]};
    vi.stubEnv('FEATURE_FLAGS_SERVICE_URL','http://owned-quirks-flags.invalid');
    const transport=vi.fn(async(url:unknown)=>{
        if(String(url)!=='http://owned-quirks-flags.invalid/internal/feature-flags/evaluated')throw new Error('Unexpected controlled transport destination: '+String(url));
        const all=Object.fromEntries(Object.keys(defaultFeatureFlags()).map(key=>[key,true]));
        return Response.json(evaluateFeatureFlags({...all,project_learning_quirks:state.enabled}));
    });vi.stubGlobal('fetch',transport);
    const admit=async()=>{
        const payload=await quirksJobPayload(owners,device,{...input,requestKey:randomUUID()});expect(payload).toBeDefined();
        job={id:randomUUID(),device_id:device.id,email:device.email,role:device.role,project_id:projectId,kind:LEARNING_QUIRKS_KIND,payload:payload!,state:'running',lease:randomUUID(),lease_until:new Date(Date.now()+120_000),percent:null};
        await assertQuirksJob(owners,device,job,db as never);return job;
    };
    const body=(raw=JSON.stringify(quirk)+'\n')=>({jobId:job.id,lease:job.lease,projectId,bindingId,instanceId,source:{jsonl:raw,fileSha256:createHash('sha256').update(raw).digest('hex'),configurationRevision:null}});
    return {state,device,actor,owners,repository,query,transport,input,admit,service,experiences,history,receipts,body};
}

afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});

describe('Core-only quirks admission and import with real installation/approval authority',()=>{
    it('keeps legacy UI-only RAG collection compatible with a client without the explicit core capability',async()=>{
        const pkg=enginePackage({localUi,learningQuirks}),f=fixture(pkg,true);
        f.device.report.capabilities=(f.device.report.capabilities as string[]).filter(value=>value!=='hosted-rag-core-v1');
        const job=await f.admit();
        expect(job.payload).toMatchObject({package:pkg,planId,planRevision:1,approvalManifest:pkg.manifest.sha256,
            approvalRoot:{kind:pkg.plugin.kind,id:pkg.plugin.id,version:pkg.plugin.version},bindingId,instanceId,configurationRevisions:[]});
        expect(pkg.config?.extra).not.toHaveProperty('ragCore');expect(pkg.config?.extra).not.toHaveProperty('hostedEmbedding');
        expect(f.device.report.capabilities).toContain('opencode-rag-ui-v1');expect(f.device.report.capabilities).not.toContain('hosted-rag-core-v1');
        expect(await f.service.import(f.device,f.body())).toMatchObject({status:'complete',imported:1,skipped:0});
        expect([...f.experiences.values()][0].data).toMatchObject({origin:'device',outcome:'unknown',source:{kind:'rag_quirk',trust:'reported',quirk}});
    });
    it('admits and imports immutable reported experience from a core-only device without UI capability',async()=>{
        const f=fixture(),job=await f.admit();
        expect(job.kind).toBe(LEARNING_QUIRKS_KIND);expect(job.payload).toMatchObject({bindingId,instanceId,package:enginePackage(),planId,planRevision:1,configurationRevisions:[]});
        expect(f.device.report.capabilities).not.toContain('opencode-rag-ui-v1');expect(job.payload.package).not.toHaveProperty('config.extra.localUi');
        expect(await f.service.import(f.device,f.body())).toMatchObject({status:'complete',imported:1,skipped:0});
        const original=JSON.stringify([...f.experiences.values()][0]);
        expect([...f.experiences.values()][0].data).toMatchObject({origin:'device',outcome:'unknown',source:{kind:'rag_quirk',trust:'reported',quirk}});
        expect(await f.service.import(f.device,f.body())).toMatchObject({status:'complete',imported:0,skipped:1});
        expect(f.experiences.size).toBe(1);expect(JSON.stringify([...f.experiences.values()][0])).toBe(original);
        expect(f.query.mock.calls.some(([sql])=>sql.includes('FROM device_install_plans'))).toBe(true);expect(f.transport).toHaveBeenCalled();
    });
    it.each([null,{...ragCore,entrypoint:'other.mjs'}])('rejects malformed explicit core despite valid legacy UI at admission: %j',async ragCore=>{
        const f=fixture(enginePackage({ragCore,hostedEmbedding,localUi,learningQuirks}),true);
        await expect(f.admit()).rejects.toMatchObject({status:409});expect(f.experiences.size).toBe(0);
    });
    it('requires the engine capability for explicit core even when the client can open a UI',async()=>{
        const f=fixture(enginePackage({ragCore,hostedEmbedding,localUi,learningQuirks}),true);
        f.device.report.capabilities=(f.device.report.capabilities as string[]).filter(value=>value!=='hosted-rag-core-v1');
        await expect(f.admit()).rejects.toMatchObject({status:409});
    });
    it.each(['approval','binding','flag'] as const)('late %s change blocks the second append, retains history, and permits safe recovery',async change=>{
        const f=fixture();await f.admit();const raw=JSON.stringify(quirk)+'\n'+JSON.stringify(otherQuirk)+'\n';
        f.state.afterFirstCommit=()=>{
            if(change==='approval'){f.state.approval='revoked';f.state.planRevision++;}
            if(change==='binding')(f.device.report.bindings as Array<{bindingId:string}>)[0].bindingId='d'.repeat(64);
            if(change==='flag')f.state.enabled=false;
        };
        const receipt=await f.service.import(f.device,f.body(raw));
        expect(receipt).toMatchObject({status:'partial',imported:1,remaining:1,safeRetry:true});expect(f.experiences.size).toBe(1);expect(f.receipts.size).toBe(1);
        const original=JSON.stringify([...f.experiences.values()][0]);
        const history=await f.repository.read(f.actor,projectId,db=>f.repository.history(db,projectId));
        expect(history).toHaveLength(1);expect(history[0].action).toBe('experience.quirk.import');
        expect(await f.owners.installations.inspectionPackage(f.actor,{deviceId:f.device.id,projectId,assetId:'rag-core',assetKind:'plugin',expectedManifest:enginePackage().manifest.sha256,bindingId})).toEqual(enginePackage());
        f.state.approval='approved';f.state.enabled=true;(f.device.report.bindings as Array<{bindingId:string}>)[0].bindingId=bindingId;
        if(change==='approval'){
            f.state.planRevision++;
            await expect(f.service.import(f.device,f.body(raw))).rejects.toMatchObject({status:409});expect(f.experiences.size).toBe(1);
            expect((await f.admit()).payload.planRevision).toBe(3);
        }
        expect(await f.service.import(f.device,f.body(raw))).toMatchObject({status:'complete',imported:1,skipped:1,remaining:0});
        expect(f.experiences.size).toBe(2);expect(f.receipts.size).toBe(2);expect(JSON.stringify([...f.experiences.values()][0])).toBe(original);
    });
});
