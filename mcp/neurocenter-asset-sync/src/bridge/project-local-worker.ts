import { scanProjectInventory } from './project-inventory.js';
import { prepareAdoptInstallation, applyAdoptInstallation } from './adopt-installation.js';
import { listLocalVariants, prepareLocalRestore, applyLocalRestore } from './local-recovery.js';
import type { Package } from './package.js';
import type { InstallSet } from './install-set.js';
import { scanOpenCodeModels } from './opencode-model-scan.js';

export const PROJECT_LOCAL_KINDS=['scan-opencode-models','scan-project-inventory','prepare-adopt-installation','apply-adopt-installation',
    'list-local-variants','prepare-local-restore','apply-local-restore'];
export const PROJECT_LOCAL_APPLIES=['apply-adopt-installation','apply-local-restore'];
export interface ProjectLocalPayload {
    package?:Package;installSet?:InstallSet;bindingId?:string;instanceId?:string;scanId?:string;candidateId?:string;expectedInventoryDigest?:string;
    recoveryId?:string;restorePaths?:string[];changePlanId?:string;changePlanRevision?:1;expectedChangeDigest?:string;
}

/** Диспетчер не выбирает пакет или путь самостоятельно: они закреплены серверным заданием. */
export async function runProjectLocalJob(job:{kind:string;project_id?:string;payload:ProjectLocalPayload},authorize:()=>Promise<unknown>,progress:(percent:number,message:string)=>Promise<unknown>):Promise<unknown> {
    const {payload}=job;const projectId=job.project_id||'';
    if(job.kind==='scan-project-inventory')return scanProjectInventory(projectId,authorize);
    if(job.kind==='scan-opencode-models')return scanOpenCodeModels(projectId,authorize);
    const pkg=payload.package;if(!pkg)throw new Error('В задании отсутствует закреплённый пакет.');
    if(job.kind==='prepare-adopt-installation')return prepareAdoptInstallation(projectId,pkg,payload.installSet,
        {scanId:payload.scanId||'',candidateId:payload.candidateId||'',digest:payload.expectedInventoryDigest||''},authorize);
    if(job.kind==='list-local-variants')return listLocalVariants(projectId,pkg,payload.installSet,authorize);
    if(job.kind==='prepare-local-restore')return prepareLocalRestore(projectId,pkg,payload.installSet,
        {recoveryId:payload.recoveryId||'',...(payload.restorePaths?{paths:payload.restorePaths}:{})},authorize);
    const options={planId:payload.changePlanId||'',revision:payload.changePlanRevision??1,digest:payload.expectedChangeDigest||'',
        expectedBindingId:payload.bindingId||'',installSet:payload.installSet};
    if(job.kind==='apply-adopt-installation')return applyAdoptInstallation(projectId,pkg,options,authorize,progress);
    if(job.kind==='apply-local-restore')return applyLocalRestore(projectId,pkg,options,authorize,progress);
    throw new Error('Неизвестное локальное действие.');
}
