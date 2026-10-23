import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import type {Pool} from 'pg';
import {normalizeProviderDescriptor,normalizeProviderReport,providerReportIdentity} from '../../shared/opencode-providers.cjs';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {requiredJobFeatures,requiredRouteFeatures} from '../../shared/feature-policy.cjs';
import {providerJobPayload,assertProviderJob} from '../src/devices/opencode-provider-jobs';
import {authorizeProviderAction} from '../src/devices/opencode-provider-permit';
import {modelFromRow,type IModelRow} from '../src/models/model-history';
import type {Device,DeviceStore} from '../src/devices/device-store';
import type {Job,JobInput} from '../src/devices/device-job.model';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {completeDeviceJob} from '../src/devices/device-completion';
import {DeviceJobs} from '../src/devices/device-jobs';
import {buildPackage} from '../src/catalog/bundle-package';
import {approvedRuntimeArtifact} from '../src/devices/runtime-job-artifact';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const {enqueue}=vi.hoisted(()=>({enqueue:vi.fn()}));
vi.mock('../src/devices/device-enqueue',()=>({enqueueDeviceJob:enqueue}));
vi.mock('../src/devices/device-operations',()=>({recordDeviceOperation:vi.fn(async()=>undefined),notifyDeviceOperations:vi.fn(async()=>undefined)}));
const deviceId='11111111-1111-4111-8111-111111111111',instanceId='22222222-2222-4222-8222-222222222222',jobId='33333333-3333-4333-8333-333333333333';
const preparationId='44444444-4444-4444-8444-444444444444',bindingId='a'.repeat(64),projectId='prj-provider',role='Разработчик';
const actor={email:'owner@example.test',activeRole:role};
const row:IModelRow={id:'model-ready',name:'Ready',descriptor:{runtime:'remote-openai',model:'test-model',capability:'chat',source:'custom',description:'',manifestSha256:null,verificationSha256:'b'.repeat(64),dimension:null,modelVersion:'v1'},revision:1,created_at:new Date(0),updated_at:new Date(0),archived_at:null};
const device=():Device=>({id:deviceId,email:actor.email,role,name:'Owned',fingerprint:bindingId,last_seen:null,revoked:false,report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','workspace-instance-v1','package-v5','opencode-providers-v1'],bindings:[{projectId,bindingId,instanceId,valid:true}]}});
const input:JobInput={kind:'prepare-opencode-provider',deviceId,projectId,requestKey:jobId,expectedBindingId:bindingId,expectedInstanceId:instanceId,providerKind:'openai-compatible',catalogModelId:row.id,expectedModelPin:modelFromRow(row).modelPin};
const expiry=()=>new Date(Date.now()+600000).toISOString();

describe('Managed local provider contract and fresh device admission',()=>{
    const query=vi.fn(),permission=vi.fn(),owned=vi.fn(),claims=vi.fn();
    const store={pool:{query},access:{claims},owned} as unknown as DeviceStore;
    const build=vi.fn(),artifacts={build} as never;
    let activeModel:IModelRow|null,endpoint:string,prepared:unknown,preparedRole:string,job:Job|undefined,current:boolean,remoteOptions:Record<string,unknown>;
    beforeEach(()=>{
        vi.clearAllMocks();vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined);
        activeModel=structuredClone(row);endpoint='https://provider.example.invalid/v1';prepared=undefined;preparedRole=role;job=undefined;current=true;remoteOptions={temperature:0.3};
        permission.mockResolvedValue(undefined);owned.mockResolvedValue(device());claims.mockResolvedValue({email:actor.email,userRoles:[role],projects:[{projectId,projectName:'Provider',role}]});
        query.mockImplementation(async(sql:string)=>({rows:sql.includes('FROM model_catalog')?(activeModel?[activeModel]:[]):sql.startsWith('SELECT base_url')?[{base_url:endpoint,options:remoteOptions}]
            :sql.startsWith('SELECT result,role')?(prepared?[{result:prepared,role:preparedRole}]:[]):sql.startsWith('SELECT * FROM bridge_jobs')?(job?[job]:[]):sql.startsWith('SELECT job.id')?(current?[{id:jobId}]:[]):[],rowCount:1}));
    });
    afterEach(()=>vi.unstubAllGlobals());
    async function payload(){return (await providerJobPayload(store,artifacts,device(),input,role))!;}
    it.each([{apiFormat:'responses'},{apiFormat:'responses',reasoningEffort:'high',store:false},{providerParameters:{custom:{enabled:false}}},{tokenLimitParameter:'max_completion_tokens'}])('Does not silently drop unsupported local-wizard settings %j',async options=>{
        remoteOptions=options;await expect(payload()).rejects.toThrow('другой протокол или дополнительные параметры');expect(build).not.toHaveBeenCalled();
    });
    async function opened(){const p=await payload();prepared={...providerReportIdentity(p.descriptor),preparationId,expiresAt:expiry()};
        const open=await providerJobPayload(store,artifacts,device(),{...input,kind:'open-opencode-provider',preparationJobId:jobId,expectedProviderSchemaDigest:(p.descriptor as {schemaDigest:string}).schemaDigest},role);
        job={id:jobId,device_id:deviceId,email:actor.email,role,project_id:projectId,kind:'open-opencode-provider',payload:open!,state:'succeeded',lease:'lease',lease_until:new Date(0),percent:100};return job;}
    it('Device gets exact pinned endpoint/options, while public reports cannot carry its URL or credential columns',async()=>{
        const p=await payload(),d=normalizeProviderDescriptor(p.descriptor),identity=providerReportIdentity(d);
        expect(d.expectations).toEqual({catalogModelId:row.id,modelPin:input.expectedModelPin,runtimeModel:'test-model',capability:'chat',baseUrl:endpoint,options:{temperature:0.3}});
        expect(JSON.stringify(identity)).not.toContain(endpoint);expect(identity).not.toHaveProperty('expectations');
        expect(query.mock.calls.some(([sql])=>/encrypted|credential|secret|api_key/i.test(String(sql)))).toBe(false);
        const result={...identity,state:'configured',ready:true,missingFields:[],revision:preparationId,checkedAt:new Date().toISOString()};
        expect(normalizeProviderReport('get-opencode-provider-status',result,d)).toEqual(result);
    });
    it.each([{field:'key',value:'OWNED_SECRET'},{field:'baseUrl',value:'http://127.0.0.1:1234'},{field:'secretHash',value:'c'.repeat(64)},{field:'expectations',value:{}}])('Public report refuses $field before receipt publication',async({field,value})=>{
        const p=await payload(),report={...providerReportIdentity(p.descriptor),preparationId,expiresAt:expiry(),[field]:value};
        expect(()=>normalizeProviderReport('prepare-opencode-provider',report,p.descriptor)).toThrow();
    });
    it.each([{value:null},{value:[]},{value:'openai-compatible'},{value:{}}])('Descriptor rejects non-record $value',({value})=>expect(()=>normalizeProviderDescriptor(value)).toThrow());
    it.each([{patch:{providerKind:['openai-compatible']}},{patch:{values:{key:'OWNED_SECRET'}}},{patch:{descriptor:{}}}])('Browser supplied unknown values never reach model reads: $patch',async({patch})=>{
        await expect(providerJobPayload(store,artifacts,device(),{...input,...patch} as unknown as JobInput,role)).rejects.toHaveProperty('status',400);
        expect(query).not.toHaveBeenCalled();
    });
    it('Another physical instance is rejected before model or preparation reads',async()=>{
        await expect(providerJobPayload(store,artifacts,device(),{...input,expectedInstanceId:jobId},role)).rejects.toHaveProperty('status',409);expect(query).not.toHaveBeenCalled();
    });
    it('Unassigned or changed model pin does not create a setup descriptor',async()=>{
        activeModel=null;await expect(payload()).rejects.toHaveProperty('status',409);
        activeModel=structuredClone(row);activeModel.descriptor.model='different';await expect(payload()).rejects.toHaveProperty('status',409);
    });
    it('Runtime-incompatible selector is refused before any native write',async()=>{
        activeModel!.descriptor.model='model with spaces';
        await expect(providerJobPayload(store,artifacts,device(),{...input,expectedModelPin:modelFromRow(activeModel!).modelPin},role)).rejects.toHaveProperty('status',409);
    });
    it('Opening requires a successful same-role preparation with exact public identity and live TTL',async()=>{
        const p=await payload(),openInput={...input,kind:'open-opencode-provider',preparationJobId:jobId,expectedProviderSchemaDigest:(p.descriptor as {schemaDigest:string}).schemaDigest};
        await expect(providerJobPayload(store,artifacts,device(),openInput,role)).rejects.toHaveProperty('status',409);
        prepared={...providerReportIdentity(p.descriptor),preparationId,expiresAt:expiry()};preparedRole='Админ проекта';
        await expect(providerJobPayload(store,artifacts,device(),openInput,role)).rejects.toHaveProperty('status',409);
        preparedRole=role;(prepared as {expiresAt:string}).expiresAt=new Date(0).toISOString();
        await expect(providerJobPayload(store,artifacts,device(),openInput,role)).rejects.toHaveProperty('status',409);
    });
    it('Save permit survives open ACK without prolonging TTL, and contains only metadata',async()=>{
        await opened();await expect(authorizeProviderAction(store,artifacts,device(),{jobId},permission)).resolves.toEqual({ok:true});
        expect(query.mock.calls.some(([sql])=>/^UPDATE|^INSERT/.test(String(sql)))).toBe(false);expect(permission).toHaveBeenCalledTimes(2);
        expect(query.mock.calls.find(([sql])=>String(sql).startsWith('SELECT job.id'))?.[0]).toContain("expiresAt')::timestamptz>clock_timestamp()");
    });
    it('Role revoked while descriptor awaits cannot save after an already successful open job',async()=>{
        await opened();permission.mockImplementationOnce(async()=>undefined).mockRejectedValueOnce(new ForbiddenException('Role revoked'));
        await expect(authorizeProviderAction(store,artifacts,device(),{jobId},permission)).rejects.toThrow('Role revoked');
        expect(requireFeaturesEnabled).not.toHaveBeenCalled();
    });
    it('Flags turned OFF during async model read prevent the later form save',async()=>{
        await opened();const original=query.getMockImplementation()!;
        query.mockImplementation(async(...args)=>{const result=await original(...args);if(String(args[0]).startsWith('SELECT base_url'))vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('OFF after await'));return result;});
        await expect(authorizeProviderAction(store,artifacts,device(),{jobId},permission)).rejects.toThrow('OFF after await');
        expect(requireFeaturesEnabled).toHaveBeenCalledWith(['opencode_providers']);
    });
    it('Lease authorization rechecks OFF after its awaited descriptor before delivering a local action',async()=>{
        await opened();job!.state='running';job!.lease_until=new Date(Date.now()+60000);
        const original=query.getMockImplementation()!;query.mockImplementation(async(...args)=>{const result=await original(...args);
            if(String(args[0]).startsWith('SELECT base_url'))vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('OFF during descriptor'));return result;});
        const service=new DeviceJobs(store,artifacts,{} as never,{} as never,{} as never);
        await expect(service.authorize(device(),jobId,'lease')).rejects.toThrow('OFF during descriptor');
    });
    it('Lease canceled or device rebound during descriptor lookup cannot deliver a local action',async()=>{
        await opened();job!.state='running';job!.lease_until=new Date(Date.now()+60000);
        const original=query.getMockImplementation()!;query.mockImplementation(async(...args)=>{const result=await original(...args);
            if(String(args[0]).startsWith('SELECT base_url'))current=false;return result;});
        const service=new DeviceJobs(store,artifacts,{} as never,{} as never,{} as never);
        await expect(service.authorize(device(),jobId,'lease')).rejects.toHaveProperty('status',409);
    });
    it('Rebind or revocation at final database admission fails without publishing a saved result',async()=>{
        await opened();current=false;await expect(authorizeProviderAction(store,artifacts,device(),{jobId},permission)).rejects.toHaveProperty('status',409);
        expect(query.mock.calls.some(([sql])=>/^UPDATE|^INSERT/.test(String(sql)))).toBe(false);
    });
    it('Changed endpoint or model after queue delivery invalidates the old descriptor',async()=>{
        const p=await payload();endpoint='https://other.example.invalid/v1';
        await expect(assertProviderJob(store,artifacts,device(),{kind:input.kind,project_id:projectId,role,payload:p})).rejects.toHaveProperty('status',409);
    });
    it('Codex request phase cannot be used to authorize a direct OpenAI provider',async()=>{
        await opened();const d=normalizeProviderDescriptor(job!.payload.descriptor);
        await expect(authorizeProviderAction(store,artifacts,device(),{jobId,phase:'request',providerId:d.providerId,schemaDigest:d.schemaDigest},permission)).rejects.toHaveProperty('status',400);
    });
    async function codexOpened(){
        const pin=require('../../shared/codex-connector-pin.json') as {sourceCommit:string;version:string;sdkVersion:string};
        const pkg=buildPackage({id:'plugin-codex',name:'Codex',kind:'plugin',version:1},[],new Date().toISOString(),{entrypoint:'plugin.mjs',extra:{
            codexConnector:{schemaVersion:1,sourceCommit:pin.sourceCommit,version:pin.version,sdkVersion:pin.sdkVersion,authOnly:true},
            runtimeArtifacts:[{target:'darwin-arm64',sha256:'f'.repeat(64),compressedBytes:100,unpackedBytes:100,filesCount:1,entrypoint:'plugin.mjs'}]}});
        build.mockResolvedValue(pkg);const previous=query.getMockImplementation()!;
        query.mockImplementation(async(...args)=>String(args[0]).includes('FROM ai_plugins')?{rows:[{id:pkg.plugin.id,version:1}],rowCount:1}:previous(...args));
        const {catalogModelId:_id,expectedModelPin:_pin,...base}=input,codex={...base,providerKind:'codex-bridge' as const};
        const p=(await providerJobPayload(store,artifacts,device(),codex,role))!;
        prepared={...providerReportIdentity(p.descriptor),preparationId,expiresAt:expiry()};
        const payload=(await providerJobPayload(store,artifacts,device(),{...codex,kind:'open-opencode-provider',preparationJobId:jobId,
            expectedProviderSchemaDigest:(p.descriptor as {schemaDigest:string}).schemaDigest},role))!;
        job={id:jobId,device_id:deviceId,email:actor.email,role,project_id:projectId,kind:'open-opencode-provider',payload,state:'succeeded',lease:'lease',lease_until:new Date(0),percent:100};
        return {d:normalizeProviderDescriptor(payload.descriptor),pkg};
    }
    it('Server selects only its pinned published Codex package; late request uses the same manifest after form expiry',async()=>{
        const {d,pkg}=await codexOpened();expect(job!.payload.connectorPackage).toEqual(pkg);expect(job!.payload).not.toHaveProperty('package');
        const selector=query.mock.calls.find(([sql])=>String(sql).includes('FROM ai_plugins'))?.[0];
        expect(selector).toContain('JOIN tool_build_jobs');expect(selector).toContain("build.state='SUCCEEDED'");
        expect(selector).toContain("build.config#>>'{source,commit}'=$1");
        job!.payload.expiresAt=new Date(0).toISOString();
        await expect(authorizeProviderAction(store,artifacts,device(),{jobId,phase:'request',providerId:d.providerId,schemaDigest:d.schemaDigest},permission)).resolves.toEqual({ok:true});
        expect(requireFeaturesEnabled).toHaveBeenCalledWith(['opencode_providers','codex_connector']);
        expect([...query.mock.calls].reverse().find(([sql])=>String(sql).startsWith('SELECT job.id'))?.[1]?.at(-1)).toBe(true);
    });
    it('Only the approved connector manifest grants runtime SHA download, preserving lease and job-kind fences',async()=>{
        const {pkg}=await codexOpened(),artifact=(pkg.config!.extra!.runtimeArtifacts as Array<{sha256:string;compressedBytes:number}>)[0];
        const q=vi.fn().mockResolvedValue({rows:[{payload:job!.payload}]});
        await expect(approvedRuntimeArtifact({query:q} as unknown as Pool,deviceId,jobId,'lease',artifact.sha256)).resolves.toEqual(artifact);
        expect(q.mock.calls[0][0]).toContain("j.state='running' AND j.lease_until>now()");
        expect(q.mock.calls[0][0]).toContain("'prepare-opencode-provider','open-opencode-provider'");
        job!.payload.descriptor={...normalizeProviderDescriptor(job!.payload.descriptor),connector:{...normalizeProviderDescriptor(job!.payload.descriptor).connector!,manifest:'e'.repeat(64)}};
        await expect(approvedRuntimeArtifact({query:q} as unknown as Pool,deviceId,jobId,'lease',artifact.sha256)).rejects.toHaveProperty('status',409);
    });
    it('An unacknowledged open job cannot authorize a Codex request',async()=>{
        const {d}=await codexOpened();job!.state='running';
        await expect(authorizeProviderAction(store,artifacts,device(),{jobId,phase:'request',providerId:d.providerId,schemaDigest:d.schemaDigest},permission)).rejects.toHaveProperty('status',409);
        expect(permission).not.toHaveBeenCalled();expect(requireFeaturesEnabled).not.toHaveBeenCalled();
    });
    it('OFF while native request waits for a connector lookup prevents a new call permit without forwarding any prompt',async()=>{
        const {d}=await codexOpened();build.mockImplementationOnce(async()=>{vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('Codex OFF'));return job!.payload.connectorPackage;});
        await expect(authorizeProviderAction(store,artifacts,device(),{jobId,phase:'request',providerId:d.providerId,schemaDigest:d.schemaDigest},permission)).rejects.toThrow('Codex OFF');
        expect(JSON.stringify(query.mock.calls)).not.toContain('prompt');
    });
    it('Another connector manifest or provider identity cannot reuse a succeeded setup job',async()=>{
        const {d,pkg}=await codexOpened();
        await expect(authorizeProviderAction(store,artifacts,device(),{jobId,phase:'request',providerId:d.providerId,schemaDigest:'e'.repeat(64)},permission)).rejects.toHaveProperty('status',409);
        build.mockResolvedValue({...pkg,manifest:{...pkg.manifest,sha256:'e'.repeat(64)}});
        await expect(authorizeProviderAction(store,artifacts,device(),{jobId,phase:'request',providerId:d.providerId,schemaDigest:d.schemaDigest},permission)).rejects.toHaveProperty('status',409);
    });
    it('New setup flags default OFF, dependencies gate Codex, status remains available for recovery',()=>{
        const flags=defaultFeatureFlags();expect(flags.opencode_providers).toBe(false);expect(flags.codex_connector).toBe(false);
        const evaluated=evaluateFeatureFlags({...flags,opencode_providers:true,codex_connector:true,computer_connections:false});
        expect(evaluated.flags.codex_connector).toBe(false);expect(evaluated.blockedBy.codex_connector).toContain('computer_connections');
        expect(requiredJobFeatures('get-opencode-provider-status')).toEqual([]);
        expect(requiredJobFeatures('open-opencode-provider',{descriptor:{providerKind:'codex-bridge'}},true)).toEqual(['opencode_providers','codex_connector']);
        expect(requiredRouteFeatures('GET','/api/tool-builds/connectors/codex')).toEqual([]);
        expect(requiredRouteFeatures('POST','/api/tool-builds',{kind:'plugin'})).toEqual(['tool_builds','tool_catalog']);
    });
    it('Identical queue request replays its prior receipt without rebuilding a descriptor or requiring enabled setup flags',async()=>{
        const existing={id:jobId,kind:input.kind,state:'succeeded',providerKind:input.providerKind};
        query.mockImplementation(async(sql:string)=>String(sql).startsWith('WITH receipt')?{rows:[{...existing,request_hash:await import('../src/devices/device-store').then(({digest})=>digest(JSON.stringify({role,request:Object.entries(input).sort(([a],[b])=>a.localeCompare(b))}))),request_device_id:deviceId}],rowCount:1}:{rows:[],rowCount:1});
        const service=new DeviceJobs(store,artifacts,{} as never,{} as never,{} as never);
        await expect(service.create(actor,input)).resolves.toMatchObject(existing);expect(enqueue).not.toHaveBeenCalled();expect(requireFeaturesEnabled).not.toHaveBeenCalled();
    });
    it('Queued view projects model identity but never the private descriptor or endpoint',async()=>{
        enqueue.mockResolvedValue({id:jobId});const service=new DeviceJobs(store,artifacts,{} as never,{} as never,{} as never);
        await expect(service.create(actor,input)).resolves.toEqual({id:jobId});
        const view=enqueue.mock.calls[0][1] as string;
        expect(view).toContain('AS "providerSchemaDigest"');expect(view).toContain('AS "catalogModelId"');
        expect(view).not.toContain('baseUrl');expect(view).not.toMatch(/(?:^|,)\s*payload(?:\s|,|$)/);
        const pending=enqueue.mock.calls[0][2];expect(pending.payload.descriptor.expectations.baseUrl).toBe(endpoint);
        vi.mocked(requireFeaturesEnabled).mockRejectedValueOnce(new ForbiddenException('OFF before enqueue'));
        await expect(enqueue.mock.calls[0][3]()).rejects.toThrow('OFF before enqueue');
    });
    it('First completion stores only the validated public report and a fixed safe message',async()=>{
        const p=await payload(),result={...providerReportIdentity(p.descriptor),preparationId,expiresAt:expiry()};
        const q=vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT * FROM bridge_jobs')?[{id:jobId,device_id:deviceId,project_id:projectId,kind:input.kind,state:'running',payload:p,lease_until:new Date(Date.now()+60000)}]:[]}));
        const pool={connect:async()=>({query:q,release:vi.fn()})} as unknown as Pool;
        await expect(completeDeviceJob(pool,deviceId,jobId,{lease:'lease',state:'succeeded',message:'OWNED_SECRET',result})).resolves.toEqual({ok:true,repeated:false});
        expect(q.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE bridge_jobs'))).toBe(true);
        expect(JSON.stringify(q.mock.calls)).not.toContain('OWNED_SECRET');expect(JSON.stringify(q.mock.calls)).not.toContain(endpoint);
    });
    it('Duplicate successful completion ACK preserves result and never records arbitrary worker message',async()=>{
        const p=await payload(),result={...providerReportIdentity(p.descriptor),preparationId,expiresAt:expiry()};
        const q=vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT * FROM bridge_jobs')?[{id:jobId,device_id:deviceId,project_id:projectId,kind:input.kind,state:'succeeded',result,payload:p,lease_until:new Date(0)}]:[]}));
        const pool={connect:async()=>({query:q,release:vi.fn()})} as unknown as Pool;
        await expect(completeDeviceJob(pool,deviceId,jobId,{lease:'lease',state:'succeeded',message:'OWNED_SECRET',result})).resolves.toEqual({ok:true,repeated:true});
        expect(q.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE'))).toBe(false);expect(JSON.stringify(q.mock.calls)).not.toContain('OWNED_SECRET');
    });
});
