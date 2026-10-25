import {ConflictException,ForbiddenException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {PluginAutoUpdateService} from '../src/plugin-auto-updates/auto-update.service';
import {autoUpdateMutation,autoUpdateTarget,pendingAutoUpdate} from '../src/plugin-auto-updates/auto-update.validation';
import type {AutoUpdateRow} from '../src/plugin-auto-updates/auto-update.types';
import {buildPackage} from '../src/catalog/bundle-package';
import type {DeviceStore} from '../src/devices/device-store';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';
import type {DeviceJobs} from '../src/devices/device-jobs';
import type {JobInput} from '../src/devices/device-job.model';
import {requireFeatureEnabled} from '../src/features/require-feature-enabled';
vi.mock('../src/features/require-feature-enabled',()=>({requireFeatureEnabled:vi.fn()}));
const actor={email:'updates@example.test',activeRole:'Разработчик'},binding='a'.repeat(64),project='prj-auto',asset='plugin-fixture';
const target={deviceId:'owned-device',projectId:project,bindingId:binding,assetId:asset};
const pkg=(version:number,config?:Parameters<typeof buildPackage>[3])=>buildPackage({id:asset,name:'Fixture',kind:'plugin',version},[{path:'fixture.mjs',content:'export default '+version+';'}],'2026-10-25',config);
/** Real policy owner runs against controlled installation/queue boundaries; receipts outlive an unconfirmed create ACK. */
function fixture(){
 let installed=pkg(1),assigned=pkg(2),catalogVersion=2,role='Разработчик',online=true,changedBinding=false,dropAck=false,revokeAtAdmission=false;
 const device={id:target.deviceId,email:actor.email,role:actor.activeRole,last_seen:new Date().toISOString(),report:{bindings:[{projectId:project,bindingId:binding}]}};
 const row:AutoUpdateRow={id:randomUUID(),owner_email:actor.email,actor_role:actor.activeRole,device_id:target.deviceId,project_id:project,binding_id:binding,asset_id:asset,
  enabled:true,revision:1,status:'waiting',message:'',next_check_at:new Date(),checked_at:null,mutation_key:randomUUID(),mutation_hash:'b'.repeat(64),pending_input:null,pending_role:null,job_id:null,lease_token:null,lease_until:null};
 const queue=new Map<string,{id:string;state:string;message:string}>();
 const query=vi.fn(async(sql:string)=>sql.includes('FROM project_assets')?{rows:[{project_id:project,asset_id:asset,asset_kind:'plugin',asset_version:assigned.plugin.version,asset_manifest:assigned.manifest.sha256,pin_snapshot:{card:{name:'Fixture'},package:assigned}}]}:{rows:[{version:catalogVersion}]});
 const store={pool:{query},ready:async()=>{},access:{claims:vi.fn(async()=>({email:actor.email,userRoles:[actor.activeRole],projects:[{projectId:project,projectName:'Fixture',role}],pluginIds:[],skillPaths:[]}))},
  owned:vi.fn(async()=>({...device,last_seen:online?new Date().toISOString():new Date(0).toISOString(),report:{bindings:[{projectId:project,bindingId:changedBinding?'c'.repeat(64):binding}]}}))};
 const installations={workspacePackages:vi.fn(async()=>[installed])};
 const plans={approvedInstalled:vi.fn(async()=>({planId:'11111111-1111-4111-8111-111111111111',planRevision:1,package:assigned}))};
 let service:PluginAutoUpdateService;
 const create=vi.fn(async(_actor:unknown,input:JobInput,admit:(db:unknown)=>Promise<void>)=>{
  if(revokeAtAdmission)row.enabled=false;
  await admit({query});
  let job=queue.get(input.requestKey);if(!job){job={id:randomUUID(),state:'queued',message:'Ожидает моста'};queue.set(input.requestKey,job);}
  if(dropAck){dropAck=false;throw Error('Controlled lost create ACK');}return job;
 });
 service=new PluginAutoUpdateService(store as unknown as DeviceStore,installations as unknown as DeviceInstallations,plans as unknown as InstallPlans,{create} as unknown as DeviceJobs);
 vi.spyOn(service.repository,'claim').mockImplementation(async()=>{if(!row.enabled)return [];row.lease_token=randomUUID();row.lease_until=new Date(Date.now()+120000);return [structuredClone(row)];});
 vi.spyOn(service.repository,'prepare').mockImplementation(async(_row,input)=>{row.pending_input=structuredClone(input);row.pending_role=row.actor_role;row.job_id=null;return structuredClone(row);});
 vi.spyOn(service.repository,'admit').mockImplementation(async(_db,claimed,input)=>{if(!row.enabled||row.lease_token!==claimed.lease_token||JSON.stringify(row.pending_input)!==JSON.stringify(input))throw new ConflictException('Policy changed');});
 vi.spyOn(service.repository,'receipt').mockImplementation(async(_row,input)=>queue.get(input.requestKey));
 vi.spyOn(service.repository,'finish').mockImplementation(async(claimed,status,message,_seconds,id,clear)=>{
  if(claimed.lease_token!==row.lease_token)return;row.status=status;row.message=message;if(id)row.job_id=id;if(clear){row.pending_input=null;row.pending_role=null;}row.lease_token=null;row.lease_until=null;
 });
 return {service,row,create,queue,plans,installations,store,
  setAssigned:(value:ReturnType<typeof pkg>)=>{assigned=value;},setInstalled:(value:ReturnType<typeof pkg>)=>{installed=value;},setCatalog:(value:number)=>{catalogVersion=value;},
  offline:()=>{online=false;},changedBinding:()=>{changedBinding=true;},revoke:()=>{role='Наблюдатель';},loseAck:()=>{dropAck=true;},disableAtAdmission:()=>{revokeAtAdmission=true;}};
}
beforeEach(()=>{vi.mocked(requireFeatureEnabled).mockReset();vi.mocked(requireFeatureEnabled).mockResolvedValue();});
describe('Opt-in approved plugin updates',()=>{
 it('enqueues the exact assigned approved version through the ordinary installer and observes its existing receipt',async()=>{
  const f=fixture();await f.service.tick();expect(f.create).toHaveBeenCalledTimes(1);expect([...f.queue.values()]).toHaveLength(1);
  expect(f.create.mock.calls[0][1]).toMatchObject({deviceId:target.deviceId,projectId:project,assetId:asset,expectedBindingId:binding,kind:'install',assetKind:'plugin',version:2,planRevision:1});
  await f.service.tick();expect(f.create).toHaveBeenCalledTimes(1);expect(f.row.status).toBe('queued');
  [...f.queue.values()][0].state='succeeded';await f.service.tick();expect(f.row.status).toBe('succeeded');expect(f.row.pending_input).toBeNull();
 });
 it('does not choose catalog latest or move an explicitly pinned project version',async()=>{
  const f=fixture();f.setAssigned(pkg(1));f.setCatalog(3);await f.service.tick();expect(f.create).not.toHaveBeenCalled();expect(f.row.message).toContain('Админ проекта');
 });
 it('waits for the exact plan approval without manufacturing an approval',async()=>{
  const f=fixture();f.plans.approvedInstalled.mockRejectedValue(new ConflictException('pending'));await f.service.tick();expect(f.create).not.toHaveBeenCalled();expect(f.row.message).toContain('план ещё не одобрен');
 });
 it('keeps the installed configuration and requires a manual plan when it changes',async()=>{
  const f=fixture();f.setAssigned(pkg(2,{extra:{userOption:'new'}}));await f.service.tick();expect(f.create).not.toHaveBeenCalled();expect(f.row.status).toBe('attention');expect(f.row.message).toContain('настройки');
 });
 it('waits offline and refuses a changed folder before preparing a job',async()=>{
  const f=fixture();f.offline();await f.service.tick();expect(f.row.message).toContain('не в сети');expect(f.create).not.toHaveBeenCalled();
  const changed=fixture();changed.changedBinding();await changed.service.tick();expect(changed.create).not.toHaveBeenCalled();expect(changed.row.status).toBe('attention');
 });
 it('rechecks current project grants instead of trusting the policy creator snapshot',async()=>{
  const f=fixture();f.revoke();await f.service.tick();expect(f.create).not.toHaveBeenCalled();expect(f.row.message).toContain('доступ');
 });
 it('a disable between preparation and queue admission cannot enqueue an update',async()=>{
  const f=fixture();f.disableAtAdmission();await f.service.tick();expect(f.queue.size).toBe(0);
 });
 it('lost create ACK retains the request key and a restarted owner recovers the accepted job without another create',async()=>{
  const f=fixture();f.loseAck();await f.service.tick();const key=f.row.pending_input?.requestKey;
  expect(f.row.message).toContain('Сверим сохранённый ключ');expect(f.queue.size).toBe(1);
  await f.service.tick();expect(f.row.pending_input?.requestKey).toBe(key);expect(f.create).toHaveBeenCalledTimes(1);expect(f.row.status).toBe('queued');
 });
 it('a confirmed failed update is not retried automatically and keeps the old package',async()=>{
  const f=fixture();await f.service.tick();[...f.queue.values()][0].state='failed';await f.service.tick();await f.service.tick();
  expect(f.create).toHaveBeenCalledTimes(1);expect(f.row.status).toBe('attention');expect((await f.installations.workspacePackages())[0].plugin.version).toBe(1);
 });
 it('feature OFF prevents new work while an existing accepted receipt can still be reconciled',async()=>{
  const f=fixture();await f.service.tick();vi.mocked(requireFeatureEnabled).mockRejectedValue(new ForbiddenException('off'));
  [...f.queue.values()][0].state='succeeded';await f.service.tick();expect(f.row.status).toBe('succeeded');expect(f.create).toHaveBeenCalledTimes(1);
  const other=fixture();await other.service.tick();expect(other.create).not.toHaveBeenCalled();
 });
 it('never silently downgrades an installed version to a manual project pin',async()=>{
  const f=fixture();f.setInstalled(pkg(3));f.setAssigned(pkg(2));await f.service.tick();expect(f.create).not.toHaveBeenCalled();expect(f.row.message).toContain('откат');
 });
});
describe('Policy input and retained request validation',()=>{
 it('retains a bounded current tuple and rejects client-supplied execution payload',()=>{
  expect(autoUpdateTarget(target)).toEqual(target);
  expect(()=>autoUpdateTarget({...target,version:2})).toThrow();expect(()=>autoUpdateTarget({...target,bindingId:'other'})).toThrow();
 });
 it('requires CAS and a durable caller key for each mode selection',()=>{
  const input={...target,enabled:true,expectedRevision:0,requestKey:randomUUID()};expect(autoUpdateMutation(input)).toEqual(input);
  for(const bad of [{...input,enabled:'true'},{...input,expectedRevision:-1},{...input,requestKey:'bad'}])expect(()=>autoUpdateMutation(bad)).toThrow();
 });
 it('a retained install cannot change binding, asset or operation after a restart',async()=>{
  const f=fixture();await f.service.tick();expect(pendingAutoUpdate(f.row).expectedBindingId).toBe(binding);
  for(const change of [{expectedBindingId:'b'.repeat(64)},{kind:'uninstall'},{assetId:'other'}])expect(()=>pendingAutoUpdate({...f.row,pending_input:{...f.row.pending_input!,...change}})).toThrow();
 });
});
