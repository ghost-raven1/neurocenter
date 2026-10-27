import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {AGENT_METHOD_WORKFLOW_JOB,AGENT_METHOD_WORKFLOW_CAPABILITY,AGENT_METHOD_WORKFLOW_PROTOCOL,AGENT_METHOD_VERSIONS,
    normalizeAgentMethodWorkflowPayload,normalizeAgentMethodWorkflowResult} from '../../../shared/agent-method-workflow.cjs';
import type {Device} from '../devices/device-store';
import type {Job,JobInput} from '../devices/device-job.model';
import {managedBinding,assertExpectedBinding} from '../devices/device-compatibility';
import {assertLocalFeature} from '../devices/local-change-jobs';

/** Capture the selected computer and folder; another binding cannot inherit execution authority. */
function target(device:Device,projectId:string|undefined,binding:unknown,instance:unknown){
    assertLocalFeature(device.report,AGENT_METHOD_WORKFLOW_CAPABILITY);
    const bindingId=managedBinding(device.report,projectId);assertExpectedBinding(bindingId,binding,true);
    const selected=Array.isArray(device.report.bindings)?device.report.bindings.find(value=>value&&typeof value==='object'&&(value as {projectId?:unknown}).projectId===projectId) as {instanceId?:unknown}|undefined:undefined;
    if(!selected?.instanceId||selected.instanceId!==instance)throw new ConflictException('Папка изменилась. Выберите компьютер и папку задачи заново.');
    return {bindingId,instanceId:selected.instanceId};
}

/** The method version, stage and deadline are fixed by the server, not supplied as runtime instructions. */
export function agentMethodJobPayload(device:Device,input:JobInput){
    if(input.kind!==AGENT_METHOD_WORKFLOW_JOB)return;
    const allowed=['deviceId','projectId','kind','requestKey','expectedBindingId','expectedInstanceId','workflow'];
    if(Object.keys(input).some(key=>!allowed.includes(key))||!input.projectId)throw new BadRequestException('Передайте проект, выбранную папку и задачу методики.');
    const workflow=input.workflow;
    if(!workflow||Object.keys(workflow).some(key=>!['method','instruction','checks'].includes(key))||!Object.prototype.hasOwnProperty.call(AGENT_METHOD_VERSIONS,workflow.method))throw new BadRequestException('Выберите методику и команды проверки.');
    try{return normalizeAgentMethodWorkflowPayload({protocol:AGENT_METHOD_WORKFLOW_PROTOCOL,workflowId:input.requestKey,requestId:input.requestKey,
        projectId:input.projectId,...target(device,input.projectId,input.expectedBindingId,input.expectedInstanceId),method:workflow.method,
        methodVersion:AGENT_METHOD_VERSIONS[workflow.method],stage:'full-cycle',instruction:workflow.instruction,checks:workflow.checks,
        deadlineAt:new Date(Date.now()+30*60*1000).toISOString(),runtime:'opencode'});}
    catch(error){if(error instanceof ConflictException)throw error;throw new BadRequestException('Задача или команды проверки имеют неподдерживаемый формат.');}
}

/** Recheck the immutable payload against current device identity before claim and every authorization poll. */
export function assertAgentMethodJob(device:Device,job:Pick<Job,'kind'|'payload'|'project_id'>):void{
    if(job.kind!==AGENT_METHOD_WORKFLOW_JOB)return;
    const payload=normalizeAgentMethodWorkflowPayload(job.payload);
    if(payload.projectId!==job.project_id)throw new ConflictException('Задание относится к другому проекту.');
    target(device,job.project_id??undefined,payload.bindingId,payload.instanceId);
}

/** An accepted completion must describe the original workflow and actual check outcomes. */
export function assertAgentMethodResult(job:Pick<Job,'kind'|'payload'|'project_id'>,result:Record<string,unknown>,failed:boolean):void{
    if(job.kind!==AGENT_METHOD_WORKFLOW_JOB)return;
    if(failed&&Object.keys(result).length===0)return;
    try{const checked=normalizeAgentMethodWorkflowResult(result,job.payload);
        if((checked.state==='succeeded')===failed)throw Error('Outcome mismatch');}
    catch{throw new ConflictException('Результат методики не соответствует исходной задаче, версии или проверкам.');}
}

/** A late success cannot outlive the user, project grant or the exact folder binding. */
export async function assertAgentMethodCompletionAccess(db:PoolClient,job:Pick<Job,'device_id'|'email'|'role'|'project_id'|'payload'>):Promise<void>{
    const device=(await db.query<Device>('SELECT * FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>now() FOR SHARE',[job.device_id,job.email])).rows[0];
    const user=(await db.query<{enabled:boolean;is_main_admin:boolean}>('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',[job.email])).rows[0];
    const grant=(await db.query<{role:string}>('SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=$2 FOR SHARE',[job.project_id,job.email])).rows[0];
    const allowed=(role:string)=>role==='Главный админ'?user?.is_main_admin:role==='Админ проекта'&&grant?.role==='Админ проекта';
    if(!device||!user?.enabled||!allowed(device.role)||!allowed(job.role))throw new ForbiddenException('Доступ к исполнению задачи отозван.');
    assertAgentMethodJob(device,{kind:AGENT_METHOD_WORKFLOW_JOB,payload:job.payload,project_id:job.project_id});
}
