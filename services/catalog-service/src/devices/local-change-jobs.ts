import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Device, DeviceStore } from './device-store';
import type { DeviceInstallations } from './device-installations';
import type { InstallPlans } from './install-plans';
import { managedBinding, assertExpectedBinding, assertPackageBridge } from './device-compatibility';
import { assertWorkspaceCapability } from './workspace-jobs';
import { assertLocalChangePlan } from './local-change-plan';
import type { Pool } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { configurationRevisionsForProbe } from './mcp-config-status';
import { validConfigurationRevisions } from './mcp-config-reports';

export interface LocalChangeInput {
    deviceId: string; projectId?: string; kind: string; assetId?: string; assetKind?: string; expectedManifest?: string; expectedBindingId?: string;
    changePlanId?: string; changePlanRevision?: number; expectedChangeDigest?: string; consentManifest?: string;
    expectedConfigurationRevisions?:Array<{assetId:string;manifest:string;revision:string|null}>;
}
export function assertLocalFeature(report: Record<string, unknown>, capability: string): void {
    assertWorkspaceCapability(report);
    if (!Array.isArray(report.capabilities) || !report.capabilities.includes(capability)) {
        throw new ConflictException('Обновите локальный MCP на странице «Начало работы»: выбранное действие требует новой возможности клиента.');
    }
}

/** Аренда очереди не продлевает срок просмотренного плана и не разрешает повторное применение. */
export async function assertLocalChangeAvailable(pool: Pool, job: {id:string;device_id:string;project_id:string|null;email:string;kind:string;payload:Record<string,unknown>}): Promise<void> {
    if (!['apply-local-change','open-local-change-report'].includes(job.kind)) { return; }
    const { rows } = await pool.query(`SELECT 1 FROM bridge_local_change_plans WHERE id=$1 AND device_id=$2 AND project_id=$3
        AND email=$4 AND binding_id=$5 AND instance_id=$6 AND digest=$7 AND revision=$8
        AND purpose='repair' AND expires_at>now() AND applied_job_id IS NULL`,[job.payload.changePlanId,job.device_id,job.project_id,job.email,
        job.payload.bindingId,job.payload.instanceId,job.payload.expectedChangeDigest,job.payload.changePlanRevision]);
    if (!rows.length) { throw new ConflictException('План изменений истёк, применён или больше не соответствует папке. Подготовьте сравнение заново.'); }
}
export async function localChangeJobPayload(store: DeviceStore, installations: DeviceInstallations, plans: InstallPlans, device: Device, input: LocalChangeInput): Promise<Record<string, unknown>> {
    const runtime = input.kind === 'probe-runtime';
    assertLocalFeature(device.report,runtime ? 'runtime-probe-v1' : 'local-change-plan-v1');
    const bindingId = managedBinding(device.report,input.projectId);
    assertExpectedBinding(bindingId,input.expectedBindingId,true);
    const binding = (device.report.bindings as Array<{projectId:string;instanceId?:string}>).find(item => item.projectId === input.projectId);
    if (!binding?.instanceId) { throw new ConflictException('Подтвердите экземпляр локальной папки в мастере проекта.'); }
    const pkg = await installations.inspectionPackage({email:device.email,activeRole:device.role},{...input,bindingId});
    const approved = await plans.approvedInstalled(input.projectId!,pkg);
    assertPackageBridge(device.report,pkg);
    const payload: Record<string,unknown> = {...approved,assetId:pkg.plugin.id,assetKind:pkg.plugin.kind,version:pkg.plugin.version,bindingId,instanceId:binding.instanceId};
    if (runtime) {
        const manifest = approved.installSet?.manifest ?? pkg.manifest.sha256;
        if (input.consentManifest !== manifest) { throw new BadRequestException('Подтвердите выполнение точного одобренного набора OpenCode перед проверкой запуска.'); }
        payload.consentManifest = manifest;
        const revisions=await configurationRevisionsForProbe(store.pool,device.email,{deviceId:device.id,projectId:input.projectId!,bindingId,instanceId:binding.instanceId,
            packages:approved.installSet?.packages??[pkg]});
        if(revisions.length){
            if(!validConfigurationRevisions(input.expectedConfigurationRevisions)||!isDeepStrictEqual(revisions,input.expectedConfigurationRevisions))throw new ConflictException('Обновите параметры MCP и подтвердите диагностику текущей ревизии настройки.');
            payload.configurationRevisions=revisions;
        }else if(input.expectedConfigurationRevisions!==undefined&&(!Array.isArray(input.expectedConfigurationRevisions)||input.expectedConfigurationRevisions.length))throw new BadRequestException('Комплект не содержит локальных настроек MCP.');
    }
    if (['apply-local-change','open-local-change-report'].includes(input.kind)) {
        if (typeof input.changePlanId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.changePlanId)
            || input.changePlanRevision !== 1 || typeof input.expectedChangeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedChangeDigest)) {
            throw new BadRequestException('Выберите подготовленный план изменений, его ревизию и SHA.');
        }
        const { rows } = await store.pool.query(`SELECT * FROM bridge_local_change_plans WHERE id=$1 AND device_id=$2 AND project_id=$3
            AND email=$4 AND expires_at>now() AND applied_job_id IS NULL`, [input.changePlanId,device.id,input.projectId,device.email]);
        const plan = rows[0];
        if (!plan || (plan.purpose ?? 'repair') !== 'repair' || plan.digest !== input.expectedChangeDigest || plan.revision !== input.changePlanRevision) {
            throw new ConflictException('План изменений истёк, уже применён или изменился. Подготовьте сравнение заново.');
        }
        assertLocalChangePlan(plan.summary,{projectId:input.projectId!,bindingId,instanceId:binding.instanceId,package:pkg});
        Object.assign(payload,{changePlanId:input.changePlanId,changePlanRevision:input.changePlanRevision,expectedChangeDigest:input.expectedChangeDigest});
    }
    return payload;
}
