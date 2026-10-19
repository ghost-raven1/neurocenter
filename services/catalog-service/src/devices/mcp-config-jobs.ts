import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Device, DeviceStore } from './device-store';
import type { DeviceInstallations } from './device-installations';
import type { InstallPlans } from './install-plans';
import type { Job, JobInput } from './device-job.model';
import { assertExpectedBinding, managedBinding, assertPackageBridge } from './device-compatibility';
import { assertLocalFeature } from './local-change-jobs';
import { assertConfigurationReport, configurationSchemaDigest, configurationUuid, CONFIGURATION_KINDS } from './mcp-config-reports';
import type { IPackage } from '../catalog/bundle-package';

const inputKeys=['deviceId','projectId','kind','requestKey','assetId','assetKind','version','expectedManifest','expectedBindingId','configurationPreparationJobId','expectedConfigurationSchemaDigest'];
function binding(device:Device,projectId:string|undefined,expected:unknown){
    assertLocalFeature(device.report,'local-mcp-config-v1');const id=managedBinding(device.report,projectId);assertExpectedBinding(id,expected,true);
    const current=(device.report.bindings as Array<{projectId:string;instanceId?:string}>).find(item=>item.projectId===projectId);
    if(!configurationUuid(current?.instanceId))throw new ConflictException('Подтвердите экземпляр папки проекта.');
    return {bindingId:id,instanceId:current.instanceId};
}
async function preparation(store:DeviceStore,device:Device,projectId:string,payload:Record<string,unknown>,id:unknown){
    if(!configurationUuid(id))throw new BadRequestException('Выберите подготовку локальной настройки.');
    const {rows}=await store.pool.query(`SELECT result,payload FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND project_id=$3
        AND email=$4 AND kind='prepare-mcp-configuration' AND state='succeeded'`,[id,device.id,projectId,device.email]);
    const row=rows[0];if(!row)throw new ConflictException('Подготовка настройки не найдена. Откройте мастер заново.');
    assertConfigurationReport('prepare-mcp-configuration',row.result,{...payload,projectId});
    if(Date.parse(row.result.expiresAt)<=Date.now() || row.payload.planId!==payload.planId || row.payload.planRevision!==payload.planRevision
        || row.payload.approvalManifest!==payload.approvalManifest)throw new ConflictException('Подготовка или одобрение изменились. Откройте мастер заново.');
    return row.result as Record<string,unknown>;
}

/** Браузер выбирает только tuple и подготовку; поля со значениями никогда не принимаются. */
export async function mcpConfigurationJobPayload(store:DeviceStore,installations:DeviceInstallations,plans:InstallPlans,device:Device,input:JobInput):Promise<Record<string,unknown>|undefined>{
    if(!CONFIGURATION_KINDS.includes(input.kind))return undefined;
    if(Object.keys(input).some(key=>!inputKeys.includes(key)) || input.assetKind!=='mcp')throw new BadRequestException('Настройка принимает только идентификаторы MCP и подготовки, без значений параметров.');
    const context=binding(device,input.projectId,input.expectedBindingId);
    const pkg=await installations.inspectionPackage({email:device.email,activeRole:device.role},{...input,bindingId:context.bindingId});
    assertPackageBridge(device.report,pkg);const schemaDigest=configurationSchemaDigest(pkg);
    if(!schemaDigest)throw new ConflictException('Эта версия MCP не содержит схемы локальной настройки.');
    const approved=await plans.approvedConfiguration(input.projectId!,pkg);
    const payload:Record<string,unknown>={...approved,...context,schemaDigest,assetId:pkg.plugin.id,assetKind:'mcp',version:pkg.plugin.version};
    if(input.kind==='open-mcp-configuration'){
        if(input.expectedConfigurationSchemaDigest!==schemaDigest)throw new ConflictException('Схема настройки изменилась. Откройте мастер заново.');
        const prepared=await preparation(store,device,input.projectId!,payload,input.configurationPreparationJobId);
        Object.assign(payload,{configurationPreparationJobId:input.configurationPreparationJobId,configurationPreparationId:prepared.preparationId,configurationExpiresAt:prepared.expiresAt});
    }
    return payload;
}

/** Создание, выдача, lease authorize и позднее сохранение повторяют один и тот же закреплённый контекст. */
export async function assertMcpConfigurationJob(store:DeviceStore,installations:DeviceInstallations,plans:InstallPlans,device:Device,job:Pick<Job,'kind'|'payload'|'project_id'>):Promise<void>{
    if(!CONFIGURATION_KINDS.includes(job.kind))return;
    const payload=job.payload;const context=binding(device,job.project_id??undefined,payload.bindingId);
    if(context.instanceId!==payload.instanceId)throw new ConflictException('Экземпляр папки изменился.');
    const pkg=await installations.inspectionPackage({email:device.email,activeRole:device.role},{deviceId:device.id,projectId:job.project_id!,
        assetId:String(payload.assetId),assetKind:'mcp',expectedManifest:(payload.package as IPackage)?.manifest?.sha256,bindingId:context.bindingId});
    if(configurationSchemaDigest(pkg)!==payload.schemaDigest)throw new ConflictException('Схема установленной версии изменилась.');
    const root=payload.approvalRoot as {kind:string;id:string;version:number}|undefined;
    if(!root)throw new ConflictException('В задании отсутствует одобренный комплект.');
    const live=await plans.delivery(payload.planId,job.project_id!,root.kind,root.id,root.version,payload.planRevision,payload.approvalManifest);
    const members=live.installSet?.packages??[live.package];
    if(!members.some(member=>member.plugin.kind==='mcp'&&member.plugin.id===pkg.plugin.id&&member.plugin.version===pkg.plugin.version&&member.manifest.sha256===pkg.manifest.sha256))throw new ConflictException('MCP отсутствует в одобренном комплекте.');
    if(job.kind==='open-mcp-configuration')await preparation(store,device,job.project_id!,payload,payload.configurationPreparationJobId);
}
