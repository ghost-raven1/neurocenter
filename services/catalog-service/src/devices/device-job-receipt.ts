import {BadRequestException,NotFoundException} from '@nestjs/common';
import type {PoolClient} from 'pg';

interface DeviceJobReadScope {email:string;main:boolean;projects:string[]}
type JobView=Record<string,unknown>&{id:string};
type ReceiptView=JobView&{requestFingerprint:string|null};

/** Точный receipt читает принятый alias без запуска, продления или изменения задания. */
export async function readDeviceJobReceipt(db:Pick<PoolClient,'query'>,view:string,scope:DeviceJobReadScope,requestKey:string){
    if(!/^[-a-f0-9]{36}$/.test(requestKey||''))throw new BadRequestException('Нужен корректный ключ запроса задания.');
    const {rows}=await db.query<ReceiptView>(`WITH receipt AS (
        SELECT job_id,device_id AS receipt_device_id,
            CASE WHEN request_hash ~ '^[a-f0-9]{64}$' THEN request_hash ELSE NULL END AS request_fingerprint
        FROM bridge_job_requests WHERE email=$1 AND request_key=$2)
        SELECT ${view},receipt.request_fingerprint AS "requestFingerprint"
        FROM bridge_jobs JOIN receipt ON receipt.job_id=bridge_jobs.id
        WHERE bridge_jobs.email=$1 AND bridge_jobs.device_id=receipt.receipt_device_id
        AND ($3::boolean OR project_id=ANY($4::text[])
            OR (project_id IS NULL AND kind IN ('choose-root','runtime-cache-policy')))
        AND EXISTS (SELECT 1 FROM bridge_devices device WHERE device.id=bridge_jobs.device_id AND device.email=$1)`,
    [scope.email,requestKey,scope.main,scope.projects]);
    const row=rows[0];
    if(!row)throw new NotFoundException('Задание не найдено в доступных вам проектах.');
    const {requestFingerprint,...job}=row;
    return {requestKey,requestFingerprint,job};
}
