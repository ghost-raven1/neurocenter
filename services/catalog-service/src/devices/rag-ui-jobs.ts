import {BadRequestException,ConflictException} from '@nestjs/common';
import {isDeepStrictEqual} from 'node:util';
import {localRagUi} from '../../../shared/rag-ui-contract.cjs';
import type {Device} from './device-store';
import type {DeviceInstallations} from './device-installations';
import type {InstallPlans} from './install-plans';
import type {Job,JobInput} from './device-job.model';
import type {IPackage} from '../catalog/bundle-package';
import {assertExpectedBinding,assertPackageBridge,managedBinding} from './device-compatibility';
import {assertLocalFeature} from './local-change-jobs';

function binding(device:Device,projectId:string|undefined,expected:unknown,instance:unknown){
    assertLocalFeature(device.report,'opencode-rag-ui-v1');
    const bindingId=managedBinding(device.report,projectId);assertExpectedBinding(bindingId,expected,true);
    const current=(device.report.bindings as Array<{projectId:string;instanceId?:string}>).find(item=>item.projectId===projectId);
    if(!current?.instanceId||current.instanceId!==instance)throw new ConflictException('Экземпляр папки изменился. Обновите список установок.');
    return {bindingId,instanceId:current.instanceId};
}
function supports(pkg:IPackage){
    try{if(localRagUi(pkg))return;}catch{/* Пакет не расширяет allowlist команды. */}
    throw new ConflictException('Обновите OpenCodeRAG: установленная версия не содержит управляемого интерфейса.');
}
/** Запуск использует установленный SHA и действующее одобрение, включая зависимость plugin-набора. */
export async function ragUiJobPayload(installations:DeviceInstallations,plans:InstallPlans,device:Device,input:JobInput){
    if(input.kind!=='open-rag-ui')return undefined;
    const fields=['deviceId','projectId','kind','requestKey','assetId','assetKind','version','expectedManifest','expectedBindingId','expectedInstanceId'];
    if(Object.keys(input).some(key=>!fields.includes(key))||!['mcp','plugin'].includes(input.assetKind??'')
        ||!Number.isSafeInteger(input.version)||Number(input.version)<1)throw new BadRequestException('Открытие принимает только точные идентификаторы установленного OpenCodeRAG.');
    const context=binding(device,input.projectId,input.expectedBindingId,input.expectedInstanceId);
    const pkg=await installations.inspectionPackage({email:device.email,activeRole:device.role},{...input,bindingId:context.bindingId});
    if(pkg.plugin.version!==input.version)throw new ConflictException('Версия установки изменилась. Обновите список установок.');
    supports(pkg);assertPackageBridge(device.report,pkg);
    const approved=await plans.approvedConfiguration(input.projectId!,pkg);
    return {...approved,...context,assetId:pkg.plugin.id,assetKind:pkg.plugin.kind,version:pkg.plugin.version};
}
/** Очередь и повторная авторизация не продлевают устаревшие права, квитанцию или одобрение. */
export async function assertRagUiJob(installations:DeviceInstallations,plans:InstallPlans,device:Device,job:Pick<Job,'kind'|'payload'|'project_id'>){
    if(job.kind!=='open-rag-ui')return;
    const payload=job.payload,context=binding(device,job.project_id??undefined,payload.bindingId,payload.instanceId);
    const pkg=await installations.inspectionPackage({email:device.email,activeRole:device.role},{deviceId:device.id,projectId:job.project_id!,
        assetId:String(payload.assetId),assetKind:String(payload.assetKind),expectedManifest:(payload.package as IPackage)?.manifest?.sha256,bindingId:context.bindingId});
    if(pkg.plugin.version!==payload.version||!isDeepStrictEqual(pkg,payload.package))throw new ConflictException('Установленный пакет изменился. Откройте интерфейс из актуальной установки.');
    supports(pkg);assertPackageBridge(device.report,pkg);
    const root=payload.approvalRoot as {kind:string;id:string;version:number}|undefined;
    if(!root)throw new ConflictException('В задании отсутствует одобрение комплекта.');
    const live=await plans.delivery(payload.planId,job.project_id!,root.kind,root.id,root.version,payload.planRevision,payload.approvalManifest);
    if(!(live.installSet?.packages??[live.package]).some(member=>isDeepStrictEqual(member,pkg)))throw new ConflictException('Пакет отсутствует в одобренном комплекте.');
}
