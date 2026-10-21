import {BadRequestException,ConflictException} from '@nestjs/common';
import {isDeepStrictEqual} from 'node:util';
import {PROJECT_AGENTS_JOB,compileProjectAgents,normalizeProjectAgentsPayload} from '../../../shared/project-agents.cjs';
import type {Device,DeviceStore} from '../devices/device-store';
import type {Job} from '../devices/device-job.model';
import {assertAgentCompletionAccess} from './agent-completion-access';
import {assertAgentConfigurationJob} from './agent-jobs';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
/** Approves exact native bytes under the original job lease; retries never replace an earlier mapping. */
export async function compileAgentJob(store:DeviceStore,device:Device,value:unknown,authorize:(id:string,lease:string)=>Promise<unknown>){
    const input=value as Record<string,unknown>|null;
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='jobId,lease,mappings,payloadManifest'
        ||!uuid(input.jobId)||!uuid(input.lease)||typeof input.payloadManifest!=='string'||!Array.isArray(input.mappings)||Buffer.byteLength(JSON.stringify(input))>128*1024)throw new BadRequestException('Передайте исходную аренду и точные соответствия моделей OpenCode.');
    await authorize(input.jobId,input.lease);
    const db=await store.pool.connect();
    try{
        await db.query('BEGIN');
        const job=(await db.query<Job>(`SELECT * FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND email=$3 AND lease=$4
            AND kind=$5 AND state='running' AND lease_until>now() FOR UPDATE`,[input.jobId,device.id,device.email,input.lease,PROJECT_AGENTS_JOB])).rows[0];
        if(!job)throw new ConflictException('Аренда настройки агентов изменилась. Повторите действие.');
        const fresh=(await db.query<Device>('SELECT * FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>now() FOR SHARE',[device.id,device.email])).rows[0];
        if(!fresh)throw new ConflictException('Подключение компьютера отозвано.');
        await authorize(input.jobId,input.lease);await assertAgentConfigurationJob(store,fresh,job,db);await assertAgentCompletionAccess(db,job);
        const payload=normalizeProjectAgentsPayload(job.payload);
        if(payload.manifestSha256!==input.payloadManifest)throw new ConflictException('Исходная настройка агентов изменилась.');
        let compilation;try{compilation=compileProjectAgents(payload,input.mappings);}catch{throw new ConflictException('Соответствие моделей OpenCode не совпадает с закреплённой настройкой проекта.');}
        if(payload.compilation&&!isDeepStrictEqual(payload.compilation,compilation))throw new ConflictException('Это задание уже одобрено с другим соответствием моделей. Создайте новую настройку.');
        if(!payload.compilation)await db.query("UPDATE bridge_jobs SET payload=jsonb_set(payload,'{compilation}',$3::jsonb),updated_at=now() WHERE id=$1 AND lease=$2",[job.id,input.lease,JSON.stringify(compilation)]);
        await db.query('COMMIT');return compilation;
    }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
}
