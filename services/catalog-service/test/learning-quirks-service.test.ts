import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import type {DeviceStore,Device} from '../src/devices/device-store';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';
import type {LearningService} from '../src/learning/learning.service';
import {LearningRepository} from '../src/learning/learning.repository';
import {LearningQuirksService} from '../src/learning-quirks/learning-quirks.service';
import {QUIRKS_SOURCE_SHA256} from '../../shared/project-learning-quirks.cjs';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeatureEnabled:vi.fn(async()=>{})}));
const projectId='prj-quirks',bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222',lease='33333333-3333-4333-8333-333333333333';
const quirk={id:'quirk:44444444-4444-4444-8444-444444444444',content:'reported source text',tags:['fixture'],confidence:0.99,lastObserved:'2026-10-24T00:00:00.000Z'};
const pkg={schemaVersion:5,plugin:{id:'rag',kind:'plugin',version:12},manifest:{sha256:'b'.repeat(64)},config:{entrypoint:'rag-plugin.mjs',extra:{runtimeArtifacts:[{}],
    localUi:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']},
    learningQuirks:{schemaVersion:1,format:'opencode-rag-quirks-jsonl',sourceSha256:QUIRKS_SOURCE_SHA256}}}};
const body=(raw=JSON.stringify(quirk)+'\n')=>({jobId,lease,projectId,bindingId,instanceId,source:{jsonl:raw,fileSha256:createHash('sha256').update(raw).digest('hex'),configurationRevision:null}});
let device:Device,role:string,installed:typeof pkg,job:Record<string,unknown>,experiences:Map<string,{projectId:string;data:Record<string,unknown>}>,receipts:Map<string,unknown>,revision:number;
let afterCommit:(()=>void)|undefined,loseAck:boolean,service:LearningQuirksService;
const query=vi.fn();
beforeEach(()=>{
    role='Разработчик';installed=structuredClone(pkg);experiences=new Map();receipts=new Map();revision=0;afterCommit=undefined;loseAck=false;
    device={id:'device-fixture',email:'dev@quirks.fixture',role,report:{protocolVersion:2,capabilities:['workspace-instance-v1','opencode-rag-ui-v1','project-learning-quirks-v1','package-v5'],bindings:[{projectId,bindingId,instanceId,valid:true}]}} as unknown as Device;
    job={id:jobId,kind:'import-learning-quirks',device_id:device.id,email:device.email,role,project_id:projectId,state:'running',lease,payload:{bindingId,instanceId,package:pkg,assetId:'rag',assetKind:'plugin',version:12,
        planId:'plan-fixture',planRevision:1,approvalManifest:'c'.repeat(64),approvalRoot:{kind:'plugin',id:'rag',version:12},configurationRevisions:[]}};
    query.mockReset();query.mockImplementation(async(sql:string,args:unknown[]=[])=>{
        if(sql.startsWith('BEGIN')||sql==='ROLLBACK'||sql.includes('pg_advisory_xact_lock'))return {rows:[]};
        if(sql==='COMMIT'){const action=afterCommit;afterCommit=undefined;action?.();if(loseAck){loseAck=false;throw new Error('COMMIT response lost');}return {rows:[]};}
        if(sql.includes('FROM projects'))return {rows:[{id:projectId}]};
        if(sql.includes('FROM project_retirements'))return {rows:[]};
        if(sql.includes('FROM platform_users'))return {rows:[{enabled:true,is_main_admin:false}]};
        if(sql.includes('FROM project_members'))return {rows:role?[{role}]:[]};
        if(sql.includes('FROM bridge_devices'))return {rows:[device]};
        if(sql.includes('FROM bridge_jobs'))return {rows:job.state==='running'&&job.lease===args[6]?[job]:[]};
        if(sql.includes('SELECT request_hash,result FROM project_learning_requests'))return {rows:receipts.has(String(args[1]))?[receipts.get(String(args[1]))]:[]};
        if(sql.includes('INSERT INTO project_learning_state'))return {rows:[]};
        if(sql.includes('SELECT revision FROM project_learning_state'))return {rows:[{revision:String(revision)}]};
        if(sql.includes('UPDATE project_learning_state')){revision=Number(args[1]);return {rows:[]};}
        if(sql.includes('SELECT id FROM project_learning_experiences')){
            if(sql.includes('id=ANY'))return {rows:(args[1] as string[]).filter(id=>experiences.get(id)?.projectId===args[0]).map(id=>({id}))};
            return {rows:experiences.get(String(args[0]))?.projectId===args[1]?[{id:args[0]}]:[]};
        }
        if(sql.includes('INSERT INTO project_learning_experiences')){const id=String(args[0]);if(experiences.has(id))return {rows:[]};experiences.set(id,{projectId:String(args[1]),data:JSON.parse(String(args[2]))});return {rows:[{id}]};}
        if(sql.includes('INSERT INTO project_learning_requests')){receipts.set(String(args[1]),{request_hash:args[3],result:JSON.parse(String(args[4]))});return {rows:[]};}
        if(sql.includes('INSERT INTO project_learning_history')||sql.includes('INSERT INTO security_events'))return {rows:[]};
        throw new Error('Unhandled fixture query: '+sql);
    });
    const db={query,release:vi.fn()},pool={query,connect:async()=>db} as unknown as Pool;
    const devices={pool,owned:async()=>device,access:{claims:async()=>({email:device.email,userRoles:[device.role],projects:[{projectId,role}]})}} as unknown as DeviceStore;
    service=new LearningQuirksService(devices,{inspectionPackage:async()=>installed} as unknown as DeviceInstallations,
        {delivery:async()=>({package:pkg})} as unknown as InstallPlans,{repository:new LearningRepository(pool)} as unknown as LearningService);
});
describe('Real import service and learning repository boundaries (controlled query transport)',()=>{
    it('records untrusted observations, then replay after lost request ACK skips existing identity',async()=>{
        const first=await service.import(device,body());expect(first).toMatchObject({status:'complete',imported:1,skipped:0});
        const saved=[...experiences.values()][0].data;expect(saved.source).toMatchObject({kind:'rag_quirk',trust:'reported',quirk});expect(saved).toMatchObject({origin:'device',outcome:'unknown'});
        const replay=await service.import(device,body());expect(replay).toMatchObject({status:'complete',imported:0,skipped:1});expect(experiences.size).toBe(1);
    });
    it('same raw record in changed full-source bytes is skipped while modified record adds immutable experience',async()=>{
        await service.import(device,body());const original=JSON.stringify([...experiences.values()][0]);
        const second={...quirk,id:'quirk:55555555-5555-4555-8555-555555555555'};
        const changed=await service.import(device,body(JSON.stringify(second)+'\n'+JSON.stringify(quirk)+'\n'));
        expect(changed).toMatchObject({imported:1,skipped:1});expect(JSON.stringify([...experiences.values()][0])).toBe(original);
        expect(await service.import(device,body(JSON.stringify({...quirk,content:'new content'})+'\n'))).toMatchObject({imported:1,skipped:0});expect(experiences.size).toBe(3);
    });
    it('rejects a corrupt later line before any writes',async()=>{
        await expect(service.import(device,body(JSON.stringify(quirk)+'\n{broken}\n'))).rejects.toMatchObject({status:400});
        expect(experiences.size).toBe(0);expect(query.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO'))).toBe(false);
    });
    it.each(['membership','binding','instance','lease','package'])('late %s changes cannot append the second record and leave a partial safe retry receipt',async change=>{
        const second={...quirk,id:'quirk:55555555-5555-4555-8555-555555555555'},raw=JSON.stringify(quirk)+'\n'+JSON.stringify(second)+'\n';
        // Ignore authorized read commits; switch the boundary only after the first real experience committed.
        const base=query.getMockImplementation()!;query.mockImplementation(async(sql:string,args:unknown[]=[])=>{
            const result=await base(sql,args);
            if(sql==='COMMIT'&&experiences.size===1){
                if(change==='membership')role='Наблюдатель';
                if(change==='binding')(device.report.bindings as Array<Record<string,unknown>>)[0].bindingId='d'.repeat(64);
                if(change==='instance')(device.report.bindings as Array<Record<string,unknown>>)[0].instanceId='66666666-6666-4666-8666-666666666666';
                if(change==='lease')job.state='cancelled';
                if(change==='package')installed={...installed,plugin:{...installed.plugin,version:13}};
            }
            return result;
        });
        expect(await service.import(device,body(raw))).toMatchObject({status:'partial',imported:1,remaining:1,safeRetry:true});expect(experiences.size).toBe(1);
    });
    it('lost COMMIT acknowledgement cannot cause a duplicate on retry',async()=>{
        const base=query.getMockImplementation()!;let injected=false;
        query.mockImplementation(async(sql:string,args:unknown[]=[])=>{
            const result=await base(sql,args);if(sql==='COMMIT'&&experiences.size===1&&!injected){injected=true;throw new Error('committed but ACK lost');}return result;
        });
        expect(await service.import(device,body())).toMatchObject({status:'partial',imported:0,remaining:1,safeRetry:true});expect(experiences.size).toBe(1);
        expect(await service.import(device,body())).toMatchObject({status:'complete',imported:0,skipped:1});expect(experiences.size).toBe(1);
    });
    it('requires exact job/device/project lease authority and rejects hidden payload text',async()=>{
        await expect(service.import(device,{...body(),jobId:'77777777-7777-4777-8777-777777777777',input:{approve:true}})).rejects.toMatchObject({status:400});
        job.state='cancelled';await expect(service.import(device,body())).rejects.toMatchObject({status:409});expect(experiences.size).toBe(0);
    });
});
