import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import {normalizeProjectConfigurationReport,normalizeProjectConfigurationSession,PROJECT_CONFIGURATION_JOB} from '../../shared/project-configuration.cjs';
import {requiredJobFeatures} from '../../shared/feature-policy.cjs';
import {authorizeProjectConfiguration,assertProjectConfigurationJob,projectConfigurationPayload} from '../src/devices/project-configuration-jobs';
import {jobMinimumLevel} from '../src/devices/device-job-access';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import type {Device,DeviceStore} from '../src/devices/device-store';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {Job,JobInput} from '../src/devices/device-job.model';
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const deviceId='11111111-1111-4111-8111-111111111111',instanceId='22222222-2222-4222-8222-222222222222',jobId='33333333-3333-4333-8333-333333333333',bindingId='a'.repeat(64),projectId='project-config';
const device=():Device=>({id:deviceId,email:'admin@example.test',role:'Админ проекта',name:'Private',fingerprint:bindingId,last_seen:null,revoked:false,report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','workspace-instance-v1','project-configuration-v1'],bindings:[{projectId,bindingId,instanceId,valid:true}]}});
const input:JobInput={kind:PROJECT_CONFIGURATION_JOB,deviceId,projectId,requestKey:jobId,expectedBindingId:bindingId,expectedInstanceId:instanceId};
describe('Pinned project configuration jobs and fresh post-ACK permits',()=>{
 const query=vi.fn(),permission=vi.fn(),workspacePackages=vi.fn(),store={pool:{query}} as unknown as DeviceStore,installations={workspacePackages} as unknown as DeviceInstallations;let job:Job|undefined,current:boolean;
 beforeEach(()=>{vi.clearAllMocks();vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined);permission.mockResolvedValue(undefined);workspacePackages.mockResolvedValue([]);job=undefined;current=true;query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT * FROM bridge_jobs')?job?[job]:[]:current&&job?[{payload:job.payload}]:[]}));});
 afterEach(()=>vi.restoreAllMocks());
 async function opened(){const payload=(await projectConfigurationPayload(installations,device(),input))!;job={id:jobId,device_id:deviceId,email:device().email,role:device().role,project_id:projectId,kind:PROJECT_CONFIGURATION_JOB,payload,state:'succeeded',lease:'lease',lease_until:new Date(0),percent:100};return payload;}
 it('accepts only identity and returns an exact identity-only opening report',async()=>{
    const payload=await opened(),descriptor=normalizeProjectConfigurationSession(payload.descriptor);expect(descriptor.ragInstallations).toEqual([]);expect(normalizeProjectConfigurationReport({...descriptor,opened:true},descriptor)).toEqual({...descriptor,opened:true});expect(jobMinimumLevel(PROJECT_CONFIGURATION_JOB)).toBe(3);expect(requiredJobFeatures(PROJECT_CONFIGURATION_JOB)).toEqual(['project_configuration','computer_connections']);expect(JSON.stringify(descriptor)).not.toMatch(/127\.0|token|content|\.md/);
 });
 it.each(['content','path','values','descriptor'])('refuses browser supplied %s before installed-package lookup',async key=>{
    await expect(projectConfigurationPayload(installations,device(),{...input,[key]:'SECRET'} as JobInput)).rejects.toHaveProperty('status',400);expect(workspacePackages).not.toHaveBeenCalled();
 });
 it.each(['capability','binding','instance'])('rejects stale %s at queue construction',async field=>{
    const d=device();if(field==='capability')d.report.capabilities=[];const request={...input,...field==='binding'?{expectedBindingId:'b'.repeat(64)}:field==='instance'?{expectedInstanceId:jobId}:{}};await expect(projectConfigurationPayload(installations,d,request)).rejects.toHaveProperty('status',409);expect(workspacePackages).not.toHaveBeenCalled();
 });
 it('standalone permit works after the opening ACK without extending TTL or writing server configuration',async()=>{
    await opened();await expect(authorizeProjectConfiguration(store,installations,device(),{jobId},permission)).resolves.toEqual({ok:true});expect(permission).toHaveBeenCalledTimes(2);expect(query.mock.calls.some(([sql])=>/^INSERT|^UPDATE/.test(String(sql)))).toBe(false);expect(query.mock.calls.at(-1)?.[0]).toContain("job.state IN ('running','succeeded')");
 });
 it('role revocation during an awaited proof blocks the later file operation',async()=>{
    await opened();permission.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ForbiddenException('revoked'));await expect(authorizeProjectConfiguration(store,installations,device(),{jobId},permission)).rejects.toThrow('revoked');
 });
 it('flag OFF after proof lookup blocks the local permit',async()=>{
    await opened();workspacePackages.mockImplementation(async()=>{vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('OFF'));return [];});await expect(authorizeProjectConfiguration(store,installations,device(),{jobId},permission)).rejects.toThrow('OFF');expect(requireFeaturesEnabled).toHaveBeenCalledWith(['project_configuration','computer_connections']);
 });
 it.each(['cancel','device-rebound','expired','changed-rag'])('fails closed for %s before returning a permit',async cause=>{
    await opened();if(cause==='cancel'){job=undefined;}if(cause==='device-rebound')current=false;if(cause==='expired')(job!.payload.descriptor as {expiresAt:string}).expiresAt=new Date(0).toISOString();if(cause==='changed-rag')(job!.payload.descriptor as {ragInstallations:unknown[]}).ragInstallations=[{kind:'mcp',id:'rag',version:1,manifest:'c'.repeat(64)}];await expect(authorizeProjectConfiguration(store,installations,device(),{jobId},permission)).rejects.toHaveProperty('status',409);
 });
 it.each([{url:'http://127.0.0.1:1'},{contents:'SECRET'},{opened:false},{recoveryPath:'/private'}])('reports reject local values or false open claims: %s',async extra=>{
    const p=await opened();expect(()=>normalizeProjectConfigurationReport({...p.descriptor as object,opened:true,...extra},p.descriptor)).toThrow();expect(()=>normalizeProjectConfigurationReport({contents:'SECRET'},p.descriptor,true)).toThrow();expect(normalizeProjectConfigurationReport({},p.descriptor,true)).toEqual({});
 });
 it('checks current RAG reference identity rather than trusting names or client metadata',async()=>{
    const p=await opened();await expect(assertProjectConfigurationJob(installations,device(),{...job!,payload:{...p,descriptor:{...p.descriptor as object,ragInstallations:[{kind:'mcp',id:'fake',version:1,manifest:'d'.repeat(64)}]}}})).rejects.toHaveProperty('status',409);
 });
});
