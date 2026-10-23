import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {RUNTIME_CACHE_POLICY_JOB,RUNTIME_CACHE_POLICY_CAPABILITY,normalizeRuntimeCachePolicyPayload,normalizeRuntimeCachePolicyResult} from '../../../shared/runtime-cache-policy.cjs';
import type {Device} from './device-store';
import type {Job,JobInput} from './device-job.model';
import type {DeviceCompletion} from './device-completion';
import {recordDeviceOperation} from './device-operations';

export const runtimeCacheWorkRole=(role:string):boolean=>['Главный админ','Админ проекта','Разработчик'].includes(role);

/** Cache policy belongs to the selected personal device and affects every project in its site profile. */
export function assertRuntimeCacheJob(device:Device,job:Pick<Job,'kind'|'payload'|'project_id'|'device_id'|'email'|'role'>):void{
    if(job.kind!==RUNTIME_CACHE_POLICY_JOB)return;
    if(job.project_id!==null||job.device_id!==device.id||job.email!==device.email)throw new ForbiddenException('Настройка кэша относится только к вашему компьютеру без привязки к проекту.');
    if(!runtimeCacheWorkRole(job.role)||!runtimeCacheWorkRole(device.role))throw new ForbiddenException('Настройка компьютера требует действующей рабочей роли пользователя и моста.');
    if(!Array.isArray(device.report.capabilities)||!device.report.capabilities.includes(RUNTIME_CACHE_POLICY_CAPABILITY))throw new ConflictException('Обновите мост, чтобы управлять кэшем комплектов.');
    try{normalizeRuntimeCachePolicyPayload(job.payload);}catch{throw new ConflictException('Контекст настройки кэша повреждён. Обновите сведения о компьютере.');}
}

/** Browser input supplies one bounded budget; paths, credentials and project authority are never accepted. */
export function runtimeCacheJobPayload(device:Device,input:JobInput,role:string){
    if(input.kind!==RUNTIME_CACHE_POLICY_JOB)return;
    const allowed=['deviceId','kind','requestKey','runtimeCachePolicy'];
    if(Object.keys(input).some(key=>!allowed.includes(key)))throw new BadRequestException('Настройка кэша принимает только компьютер, действие и лимит.');
    let payload;try{payload=normalizeRuntimeCachePolicyPayload(input.runtimeCachePolicy);}catch(error){throw new BadRequestException((error as Error).message);}
    assertRuntimeCacheJob(device,{kind:input.kind,payload,project_id:null,device_id:input.deviceId,email:device.email,role});
    return payload;
}

/** The last device/job read fences revocation or rebinding while fresh roles and feature flags were awaited. */
export async function assertRuntimeCacheAuthority(db:Pick<PoolClient,'query'>,device:Device,job:Pick<Job,'id'|'kind'|'role'|'payload'|'lease'>):Promise<void>{
    if(job.kind!==RUNTIME_CACHE_POLICY_JOB)return;
    const current=await db.query(`SELECT job.id FROM bridge_jobs job JOIN bridge_devices device ON device.id=job.device_id
        WHERE job.id=$1 AND job.device_id=$2 AND job.email=$3 AND job.role=$4 AND job.lease=$5
        AND job.project_id IS NULL AND job.state='running' AND job.lease_until>clock_timestamp() AND job.payload=$6::jsonb
        AND device.email=$3 AND device.role=$7 AND NOT device.revoked AND device.expires_at>clock_timestamp()
        AND device.report->'capabilities' ? $8`,[job.id,device.id,device.email,job.role,job.lease,JSON.stringify(job.payload),device.role,RUNTIME_CACHE_POLICY_CAPABILITY]);
    if(!current.rows.length)throw new ConflictException('Компьютер, права или задание настройки кэша изменились. Обновите данные.');
}

/** A saved local receipt can be acknowledged after its lease or feature expired; it never requests another write. */
export async function completeRuntimeCachePolicy(db:Pick<PoolClient,'query'>,job:{id:string;kind:string;state:string;project_id:string|null;email:string;payload:Record<string,unknown>;result:unknown},input:DeviceCompletion){
    if(job.kind!==RUNTIME_CACHE_POLICY_JOB)return;
    let payload,result:Record<string,unknown>;
    try{
        if(job.project_id!==null)throw Error();
        payload=normalizeRuntimeCachePolicyPayload(job.payload);
        if(input.state==='failed'){
            if(Object.keys(input.result).length)throw Error();
            result={};
        }else{
            result={...normalizeRuntimeCachePolicyResult(input.result)};
            if(payload.action==='set'&&(result.limitBytes!==payload.limitBytes||Number(result.usedBytes)>payload.limitBytes
                ||result.revision!==payload.expectedRevision&&result.revision!==payload.expectedRevision+1))throw Error();
        }
    }catch{throw new ConflictException('Квитанция кэша не соответствует исходному действию или содержит неподдерживаемые данные.');}
    if(['succeeded','failed'].includes(job.state)){
        if(job.state!==input.state||!isDeepStrictEqual(job.result,result))throw new ConflictException('Настройка кэша уже содержит другой результат.');
        return {ok:true as const,repeated:true};
    }
    if(!['running','reconciling'].includes(job.state))throw new ConflictException('Настройка кэша не была принята мостом.');
    const message=input.state==='failed'?'Настройка кэша не выполнена. Проверьте лимит, ревизию и доступ к компьютеру; введённое значение сохранено.'
        :payload.action==='inspect'?'Состояние кэша компьютера получено.':'Лимит кэша компьютера подтверждён. Готовые комплекты сохранены.';
    const percent=input.state==='succeeded'?100:0;
    await db.query('UPDATE bridge_jobs SET state=$2,percent=$3,message=$4,result=$5,updated_at=now() WHERE id=$1',[job.id,input.state,percent,message,result]);
    await recordDeviceOperation(db,job,input.state.toUpperCase(),percent,message);
    return {ok:true as const,repeated:false};
}
