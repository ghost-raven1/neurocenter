import {ConflictException} from '@nestjs/common';
import type {PoolClient} from 'pg';

interface RequestIdentity {email:string;deviceId:string;requestKey:string;requestHash:string}
type JobRow=Record<string,unknown>&{id:string};
type ReceiptRow=JobRow&{request_hash:string|null;request_device_id:string};
type Queryable=Pick<PoolClient,'query'>;

/** Ключ объединённого запроса принадлежит своему actor/device и сохраняется до удаления job. */
export async function findDeviceJobRequest(db:Queryable,view:string,input:RequestIdentity):Promise<JobRow|undefined>{
    const {rows}=await db.query<ReceiptRow>(`WITH receipt AS (
        SELECT job_id,request_hash AS receipt_hash,device_id AS receipt_device_id
        FROM bridge_job_requests WHERE email=$1 AND request_key=$2)
        SELECT ${view},receipt_hash AS request_hash,device_id AS request_device_id
        FROM bridge_jobs JOIN receipt ON bridge_jobs.id=receipt.job_id
        WHERE bridge_jobs.email=$1 AND device_id=receipt_device_id`,[input.email,input.requestKey]);
    const row=rows[0];
    if(!row)return undefined;
    if(row.request_hash!==input.requestHash||row.request_device_id!==input.deviceId){
        throw new ConflictException('Ключ запроса уже использован с другими параметрами.');
    }
    const {request_hash:_hash,request_device_id:_device,...job}=row;
    return job;
}

/** Привязка не перезаписывается: конкурентный запрос получает прежний job либо конфликт. */
export async function saveDeviceJobRequest(client:Queryable,view:string,input:RequestIdentity,jobId:string):Promise<JobRow>{
    await client.query(`INSERT INTO bridge_job_requests(email,request_key,device_id,request_hash,job_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(email,request_key) DO NOTHING`,
    [input.email,input.requestKey,input.deviceId,input.requestHash,jobId]);
    const saved=await findDeviceJobRequest(client,view,input);
    if(!saved)throw new ConflictException('Не удалось подтвердить ключ запроса. Повторите действие.');
    return saved;
}
