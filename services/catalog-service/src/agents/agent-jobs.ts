import {BadRequestException,ConflictException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {PROJECT_AGENTS_CAPABILITY,PROJECT_AGENTS_JOB,createProjectAgentsPayload,normalizeProjectAgentsPayload,validateProjectAgentsResult} from '../../../shared/project-agents.cjs';
import type {Device,DeviceStore} from '../devices/device-store';
import type {Job,JobInput} from '../devices/device-job.model';
import {managedBinding,assertExpectedBinding} from '../devices/device-compatibility';
import {assertLocalFeature} from '../devices/local-change-jobs';
import {ProjectAgentRepository} from './project-agent.repository';
import {revision} from './agent-validation';
import {agentModelRequirements} from './agent-model-requirements';
function context(device:Device,projectId:string|undefined,expected:unknown,instance:unknown){
    assertLocalFeature(device.report,PROJECT_AGENTS_CAPABILITY);
    const bindingId=managedBinding(device.report,projectId);assertExpectedBinding(bindingId,expected,true);
    const binding=(device.report.bindings as Array<{projectId:string;instanceId?:string}>).find(row=>row.projectId===projectId);
    if(!binding?.instanceId||binding.instanceId!==instance)throw new ConflictException('Экземпляр папки изменился. Выберите компьютер и папку заново.');
    return {bindingId,instanceId:binding.instanceId};
}
/** Only server-pinned desired state becomes a bridge job; the browser cannot supply prompt bytes directly. */
export async function agentConfigurationJobPayload(store:DeviceStore,device:Device,input:JobInput){
    if(input.kind!==PROJECT_AGENTS_JOB)return;
    if(Object.keys(input).some(key=>!['deviceId','projectId','kind','requestKey','expectedBindingId','expectedInstanceId','expectedAgentsRevision'].includes(key)))throw new BadRequestException('Передайте точную ревизию настройки и выбранную папку.');
    revision(input.expectedAgentsRevision);const target=context(device,input.projectId,input.expectedBindingId,input.expectedInstanceId);
    const snapshot=await new ProjectAgentRepository(store.pool).snapshot(input.projectId!);
    if(snapshot.revision!==input.expectedAgentsRevision||snapshot.revision<1)throw new ConflictException('Настройки агентов изменились. Примените актуальную ревизию.');
    return createProjectAgentsPayload({schemaVersion:2,projectId:input.projectId!,...target,...snapshot,modelRequirements:await agentModelRequirements(store.pool,input.projectId!,snapshot.agents,device)});
}
/** Rechecked before lease delivery and before local commit; editing desired state invalidates an old queued snapshot. */
export async function assertAgentConfigurationJob(store:DeviceStore,device:Device,job:Pick<Job,'kind'|'payload'|'project_id'>,db:Pick<PoolClient,'query'>=store.pool):Promise<void>{
    if(job.kind!==PROJECT_AGENTS_JOB)return;
    const payload=normalizeProjectAgentsPayload(job.payload),target=context(device,job.project_id??undefined,payload.bindingId,payload.instanceId);
    const snapshot=await new ProjectAgentRepository(store.pool).snapshot(job.project_id!,db);
    const {compilation:_compilation,...base}=payload;
    if(snapshot.revision<1||!isDeepStrictEqual(createProjectAgentsPayload({schemaVersion:2,projectId:job.project_id!,...target,...snapshot,modelRequirements:await agentModelRequirements(db,job.project_id!,snapshot.agents,device)}),base))throw new ConflictException('Это задание относится к прежней настройке агентов. Примените текущую ревизию.');
}
/** Old valid receipts remain historical evidence and cannot confirm a newer desired revision or another target. */
export function assertAgentConfigurationResult(job:Pick<Job,'kind'|'payload'|'project_id'>,result:Record<string,unknown>,failed:boolean):void{
    if(job.kind!==PROJECT_AGENTS_JOB)return;
    try{if(failed){if(Object.keys(result).length&&(Object.keys(result).some(key=>!['code','agentId','modelId','action'].includes(key))||result.code!=='OPENCODE_AGENT_MODEL_SETUP_REQUIRED'||result.action!=='sync-opencode-models'||typeof result.agentId!=='string'||!normalizeProjectAgentsPayload(job.payload).agents.some(agent=>agent.id===result.agentId)||result.modelId!==undefined&&result.modelId!==normalizeProjectAgentsPayload(job.payload).agents.find(agent=>agent.id===result.agentId)?.model?.replace(/^neurocenter\//,'')))throw Error('Private failure');}else{const checked=validateProjectAgentsResult(result,job.payload);if(checked.projectId!==job.project_id)throw Error('Wrong project');}}
    catch{throw new ConflictException('Квитанция настройки агентов не соответствует исходному набору, ревизии и папке.');}
}
