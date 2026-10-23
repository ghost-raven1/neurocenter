import {ConflictException,ForbiddenException} from '@nestjs/common';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {normalizeProjectAgentsPayload} from '../../../shared/project-agents.cjs';
import type {Device} from '../devices/device-store';
import {managedBinding} from '../devices/device-compatibility';
import {agentModelRequirements} from './agent-model-requirements';
/** A late acknowledgement cannot promote an answer from revoked access, another folder or another model pin. */
export async function assertAgentCompletionAccess(db:PoolClient,job:{device_id:string;email:string;role:string;project_id:string|null;payload:Record<string,unknown>}):Promise<void>{
    const payload=normalizeProjectAgentsPayload(job.payload);
    const device=(await db.query<Device>('SELECT * FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>now() FOR SHARE',[job.device_id,job.email])).rows[0];
    const user=(await db.query<{enabled:boolean;is_main_admin:boolean}>('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',[job.email])).rows[0];
    const grant=(await db.query<{role:string}>('SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=$2 FOR SHARE',[job.project_id,job.email])).rows[0];
    const allowed=(role:string)=>role==='Главный админ'?user?.is_main_admin:role==='Админ проекта'&&grant?.role==='Админ проекта';
    if(!device||!user?.enabled||!allowed(device.role)||!allowed(job.role))throw new ForbiddenException('Доступ к настройке агентов отозван.');
    const binding=Array.isArray(device.report.bindings)?device.report.bindings.find(item=>item&&typeof item==='object'&&(item as {projectId?:unknown}).projectId===job.project_id) as {instanceId?:unknown}|undefined:undefined;
    if(managedBinding(device.report,job.project_id??undefined)!==payload.bindingId||binding?.instanceId!==payload.instanceId)throw new ConflictException('Папка изменилась до подтверждения настройки агентов.');
    if(!isDeepStrictEqual(await agentModelRequirements(db,job.project_id!,payload.agents,device),payload.modelRequirements))throw new ConflictException('Модель изменилась до подтверждения настройки агентов.');
}
