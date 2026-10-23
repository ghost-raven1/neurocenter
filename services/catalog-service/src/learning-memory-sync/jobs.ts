import {BadRequestException,ConflictException} from '@nestjs/common';
import {isDeepStrictEqual} from 'node:util';
import type {IAccessActor} from '../access/access.model';
import type {Device,DeviceStore} from '../devices/device-store';
import type {DeviceInstallations} from '../devices/device-installations';
import type {InstallPlans} from '../devices/install-plans';
import type {Job,JobInput} from '../devices/device-job.model';
import {assertExpectedBinding,assertManagedBridge,assertPackageBridge,managedBinding} from '../devices/device-compatibility';
import {assertLocalFeature} from '../devices/local-change-jobs';
import {LearningRepository} from '../learning/learning.repository';
import {MEMORY_SYNC_JOB,MEMORY_SYNC_CAPABILITY,memoryRecipeSupported,normalizeMemorySyncPayload,type MemorySyncPayload} from '../../../shared/project-learning-memory-sync.cjs';
import type {IPackage} from '../catalog/bundle-package';

type Owners={store:DeviceStore;installations:DeviceInstallations;plans:InstallPlans};
const changed=()=>new ConflictException('Знания, привязка или установка Memory изменились. Обновите мастер перед продолжением.');
function binding(device:Device,projectId:string,expected:unknown,instance:unknown){
 assertManagedBridge(device.report);assertLocalFeature(device.report,MEMORY_SYNC_CAPABILITY);
 const bindingId=managedBinding(device.report,projectId);assertExpectedBinding(bindingId,expected,true);
 const found=(device.report.bindings as Array<{projectId:string;instanceId?:string}>|undefined)?.find(item=>item.projectId===projectId);
 if(!found?.instanceId||found.instanceId!==instance)throw changed();return {bindingId,instanceId:found.instanceId};
}
async function context(owners:Owners,actor:IAccessActor,projectId:string){
 const repository=new LearningRepository(owners.store.pool);return repository.read(actor,projectId,db=>repository.context(db,projectId));
}
function supported(pkg:IPackage){if(!memoryRecipeSupported(pkg))throw new ConflictException('Эта версия MCP Memory не поддерживает безопасную синхронизацию. Обновите управляемую установку из каталога.');}

/** New work captures an approved snapshot and an exact installed target; graph contents stay on the device. */
export async function memorySyncJobPayload(owners:Owners,device:Device,input:JobInput,actor:IAccessActor){
 if(input.kind!==MEMORY_SYNC_JOB)return;
 const allowed=['kind','deviceId','projectId','requestKey','assetId','assetKind','version','expectedManifest','expectedBindingId','expectedInstanceId','expectedLearningRevision','expectedLearningDigest','memoryMode'];
 if(Object.keys(input).some(key=>!allowed.includes(key))||input.assetKind!=='mcp'||!input.projectId||!['sync','cleanup'].includes(input.memoryMode??''))throw new BadRequestException('Выберите проект, компьютер и установленный MCP Memory.');
 const target=binding(device,input.projectId,input.expectedBindingId,input.expectedInstanceId);
 const pkg=await owners.installations.inspectionPackage(actor,{...input,bindingId:target.bindingId});supported(pkg);assertPackageBridge(device.report,pkg);
 if(pkg.plugin.version!==input.version||pkg.manifest.sha256!==input.expectedManifest)throw changed();
 const bundle=await context(owners,actor,input.projectId);
 if(bundle.revision!==input.expectedLearningRevision||bundle.digest!==input.expectedLearningDigest)throw changed();
 const memory:MemorySyncPayload=normalizeMemorySyncPayload({schemaVersion:1,projectId:input.projectId,...target,assetId:pkg.plugin.id,version:pkg.plugin.version,manifest:pkg.manifest.sha256,
  learningRevision:bundle.revision,learningDigest:bundle.digest,mode:input.memoryMode});
 const approved=memory.mode==='sync'?await owners.plans.approvedConfiguration(input.projectId,pkg):{package:pkg};
 return {...approved,...target,assetId:pkg.plugin.id,assetKind:'mcp',version:pkg.plugin.version,memory};
}

/** Every protected context request repeats the snapshot, target and immutable package checks. */
export async function assertMemorySyncJob(owners:Owners,device:Device,job:Pick<Job,'kind'|'role'|'email'|'project_id'|'payload'>){
 if(job.kind!==MEMORY_SYNC_JOB)return;
 let memory:MemorySyncPayload;try{memory=normalizeMemorySyncPayload(job.payload.memory);}catch{throw changed();}
 if(memory.projectId!==job.project_id||device.email!==job.email)throw changed();
 binding(device,memory.projectId,memory.bindingId,memory.instanceId);
 const actor={email:job.email,activeRole:job.role};
 const pkg=await owners.installations.inspectionPackage(actor,{deviceId:device.id,projectId:memory.projectId,assetId:memory.assetId,assetKind:'mcp',expectedManifest:memory.manifest,bindingId:memory.bindingId});
 supported(pkg);assertPackageBridge(device.report,pkg);
 if(pkg.plugin.version!==memory.version||!isDeepStrictEqual(pkg,job.payload.package))throw changed();
 if(memory.mode==='sync'){
  const root=job.payload.approvalRoot as {kind:string;id:string;version:number}|undefined;if(!root)throw changed();
  const live=await owners.plans.delivery(job.payload.planId,memory.projectId,root.kind,root.id,root.version,job.payload.planRevision,job.payload.approvalManifest);
  if(!(live.installSet?.packages??[live.package]).some(member=>isDeepStrictEqual(member,pkg)))throw changed();
 }
 const bundle=await context(owners,actor,memory.projectId);
 if(bundle.revision!==memory.learningRevision||bundle.digest!==memory.learningDigest)throw changed();
 return {schemaVersion:1 as const,payload:memory,context:bundle,package:pkg};
}
