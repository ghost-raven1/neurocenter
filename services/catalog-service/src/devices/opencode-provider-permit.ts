import {BadRequestException,ConflictException} from '@nestjs/common';
import {normalizeProviderDescriptor} from '../../../shared/opencode-providers.cjs';
import {requiredJobFeatures} from '../../../shared/feature-policy.cjs';
import {requireFeaturesEnabled} from '../features/require-feature-enabled';
import type {Device,DeviceStore} from './device-store';
import type {DeviceArtifacts} from './device-artifacts';
import type {Job} from './device-job.model';
import {assertProviderJob} from './opencode-provider-jobs';

/** Form save survives its open ACK; paid Codex admission survives form TTL but never revoked scope or flags. */
export async function authorizeProviderAction(store:DeviceStore,artifacts:DeviceArtifacts,device:Device,input:unknown,
    permission:(role:string,projectId?:string)=>Promise<unknown>){
    const body=input as {jobId?:unknown;phase?:unknown;providerId?:unknown;schemaDigest?:unknown}|null;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['jobId','phase','providerId','schemaDigest'].includes(key))
        ||typeof body.jobId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(body.jobId)
        ||body.phase!==undefined&&body.phase!=='request')throw new BadRequestException('Разрешение принимает только исходное задание открытия и фазу вызова.');
    const call=body.phase==='request';
    const job=(await store.pool.query<Job>(`SELECT * FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND email=$3
        AND kind='open-opencode-provider' AND state IN ('running','succeeded')`,[body.jobId,device.id,device.email])).rows[0];
    if(!job||call&&job.state!=='succeeded')throw new ConflictException('Открытие провайдера не подтверждено этим компьютером.');
    const d=normalizeProviderDescriptor(job.payload.descriptor);
    if(call?(body.providerId!==d.providerId||body.schemaDigest!==d.schemaDigest):(body.providerId!==undefined||body.schemaDigest!==undefined))throw new ConflictException('Запрос относится к другой настройке провайдера.');
    if(call&&d.providerKind!=='codex-bridge')throw new BadRequestException('Разрешение вызова поддерживает только управляемый коннектор Codex.');
    await permission(job.role,job.project_id??undefined);
    await assertProviderJob(store,artifacts,device,job,call);
    const current=await store.pool.query(`SELECT job.id FROM bridge_jobs job JOIN bridge_devices device ON device.id=job.device_id
        WHERE job.id=$1 AND job.device_id=$2 AND job.email=$3 AND job.role=$4 AND job.kind='open-opencode-provider'
        AND job.state IN ('running','succeeded') AND job.payload->'descriptor'=$5::jsonb
        AND device.email=$3 AND device.role=$6 AND NOT device.revoked AND device.expires_at>clock_timestamp()
        AND EXISTS(SELECT 1 FROM projects WHERE id=job.project_id)
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(device.report->'bindings') binding WHERE binding->>'projectId'=job.project_id
            AND binding->>'bindingId'=$7 AND binding->>'instanceId'=$8 AND binding->>'valid' IS DISTINCT FROM 'false')
        AND ($9::boolean OR (job.payload->>'expiresAt')::timestamptz>clock_timestamp())`,
    [job.id,device.id,device.email,job.role,JSON.stringify(d),device.role,d.bindingId,d.instanceId,call]);
    if(!current.rows.length)throw new ConflictException('Сессия настройки отозвана, истекла или папка изменилась.');
    await permission(job.role,job.project_id??undefined);
    await requireFeaturesEnabled(requiredJobFeatures('open-opencode-provider',job.payload,true));
    return {ok:true};
}
