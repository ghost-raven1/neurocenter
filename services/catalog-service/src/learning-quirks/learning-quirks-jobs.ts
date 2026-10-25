import {BadRequestException,ConflictException} from '@nestjs/common';
import {isDeepStrictEqual} from 'node:util';
import type {Pool,PoolClient} from 'pg';
import {supportsLearningQuirks,normalizeQuirksLimits,normalizeQuirksReceipt} from '../../../shared/project-learning-quirks.cjs';
import type {DeviceStore,Device} from '../devices/device-store';
import type {DeviceInstallations} from '../devices/device-installations';
import type {InstallPlans} from '../devices/install-plans';
import type {Job,JobInput} from '../devices/device-job.model';
import {ragInstallationJobPayload,assertRagInstallation} from '../devices/rag-installation-authority';
import {assertLocalFeature} from '../devices/local-change-jobs';
import {configurationRevisionsForProbe} from '../devices/mcp-config-status';
import {validConfigurationRevisions} from '../devices/mcp-config-reports';
import type {IPackage} from '../catalog/bundle-package';
import {requireFeatureEnabled} from '../features/require-feature-enabled';

export const LEARNING_QUIRKS_KIND='import-learning-quirks';
export interface LearningQuirksOwners {store:DeviceStore;installations:DeviceInstallations;plans:InstallPlans}
const fields=['deviceId','projectId','kind','requestKey','assetId','assetKind','version','expectedManifest','expectedBindingId','expectedInstanceId','expectedConfigurationRevisions'];
/** Public input selects an exact installation, never a source path or quirk text. */
export async function quirksJobPayload(owners:LearningQuirksOwners,device:Device,input:JobInput){
    if(input.kind!==LEARNING_QUIRKS_KIND)return undefined;
    if(Object.keys(input).some(key=>!fields.includes(key))||!validConfigurationRevisions(input.expectedConfigurationRevisions))throw new BadRequestException('Выберите текущую установку RAG и обновите статус её настройки.');
    await requireFeatureEnabled('project_learning_quirks');assertLocalFeature(device.report,'project-learning-quirks-v1');
    const {expectedConfigurationRevisions,...target}=input;
    const approved=await ragInstallationJobPayload(owners.installations,owners.plans,device,target,'core');
    if(!approved||!supportsLearningQuirks(approved.package))throw new ConflictException('Обновите OpenCodeRAG из каталога: нужен проверенный формат кварков.');
    const revisions=await configurationRevisionsForProbe(owners.store.pool,device.email,{deviceId:device.id,projectId:input.projectId!,bindingId:approved.bindingId,
        instanceId:approved.instanceId,packages:[approved.package]});
    if(!isDeepStrictEqual(revisions,expectedConfigurationRevisions))throw new ConflictException('Настройка RAG изменилась. Обновите её статус перед сбором.');
    return {...approved,configurationRevisions:revisions,quirksLimits:normalizeQuirksLimits()};
}
/** Claim, pre-read authorization and each append recheck the current package, approval and configuration. */
export async function assertQuirksJob(owners:LearningQuirksOwners,device:Device,job:Pick<Job,'kind'|'payload'|'project_id'>,db?:Pick<PoolClient,'query'>){
    if(job.kind!==LEARNING_QUIRKS_KIND)return;
    normalizeQuirksLimits(job.payload.quirksLimits);
    await requireFeatureEnabled('project_learning_quirks');assertLocalFeature(device.report,'project-learning-quirks-v1');
    await assertRagInstallation(owners.installations,owners.plans,device,job,'core',db);
    if(!supportsLearningQuirks(job.payload.package))throw new ConflictException('Установка не подтверждает формат кварков. Обновите RAG.');
    const revisions=await configurationRevisionsForProbe((db??owners.store.pool) as Pool,device.email,{deviceId:device.id,projectId:job.project_id!,
        bindingId:String(job.payload.bindingId),instanceId:String(job.payload.instanceId),packages:[job.payload.package as IPackage]});
    if(!validConfigurationRevisions(job.payload.configurationRevisions)||!isDeepStrictEqual(revisions,job.payload.configurationRevisions))throw new ConflictException('Настройка RAG изменилась. Создайте новый сбор.');
}
/** Failed partial receipts survive completion; raw source data can never be echoed into a job result. */
export function assertQuirksJobResult(result:Record<string,unknown>,failed:boolean){
    if(failed&&Object.keys(result).length===0)return;
    const receipt=normalizeQuirksReceipt(result);
    if(failed?receipt.status!=='partial':receipt.status!=='complete')throw new ConflictException('Сбор кварков не подтвердил полное завершение. Повтор безопасен.');
}
