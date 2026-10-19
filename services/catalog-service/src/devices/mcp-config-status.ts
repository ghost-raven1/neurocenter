import { ConflictException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { IPackage } from '../catalog/bundle-package';
import { assertConfigurationReport, configurationSchemaDigest, validConfigurationRevisions, type ConfigurationStatus, type ConfigurationRevision } from './mcp-config-reports';

export interface ConfigurationStatusScope {deviceId:string;projectId:string;bindingId:string;instanceId:string;package:IPackage}
/** После разрешения локальной записи прежний ready больше не подтверждает параметры, даже при потере ответа формы. */
export async function readConfigurationState(pool:Pool,email:string,scope:ConfigurationStatusScope):Promise<{status?:ConfigurationStatus;invalidatedAt?:string;observedAt?:string}>{
    const {rows}=await pool.query(`SELECT invalid.at AS "invalidatedAt",checked.result,checked.state,checked.observed_at AS "observedAt" FROM
        (SELECT max((changed.payload->>'configurationInvalidatedAt')::timestamptz) AS at FROM bridge_jobs changed
            WHERE changed.email=$1 AND changed.device_id=$2 AND changed.project_id=$3 AND changed.kind='open-mcp-configuration'
                AND changed.payload->>'bindingId'=$4 AND changed.payload->>'instanceId'=$5 AND changed.payload->'package'->'plugin'->>'id'=$6
                AND changed.payload->'package'->'manifest'->>'sha256'=$7 AND changed.payload ? 'configurationInvalidatedAt') invalid
        LEFT JOIN LATERAL (SELECT checked.result,checked.state,COALESCE(checked.started_at,checked.created_at) AS observed_at FROM bridge_jobs checked WHERE checked.email=$1 AND checked.device_id=$2 AND checked.project_id=$3
        AND checked.kind='get-mcp-configuration-status' AND checked.state IN ('succeeded','failed') AND checked.payload->>'bindingId'=$4
        AND checked.payload->>'instanceId'=$5 AND checked.payload->'package'->'plugin'->>'id'=$6
        AND checked.payload->'package'->'manifest'->>'sha256'=$7
        AND COALESCE(checked.started_at,checked.created_at)>=COALESCE(invalid.at,'-infinity'::timestamptz)
        ORDER BY COALESCE(checked.started_at,checked.created_at) DESC,checked.id DESC LIMIT 1) checked ON true`,
    [email,scope.deviceId,scope.projectId,scope.bindingId,scope.instanceId,scope.package.plugin.id,scope.package.manifest.sha256]);
    const invalidatedAt=rows[0]?.invalidatedAt?new Date(rows[0].invalidatedAt).toISOString():undefined;
    const observedAt=rows[0]?.observedAt?new Date(rows[0].observedAt).toISOString():undefined;
    if(rows[0]?.state!=='succeeded')return {invalidatedAt,observedAt};
    try{assertConfigurationReport('get-mcp-configuration-status',rows[0].result,{...scope,projectId:scope.projectId});return {status:rows[0].result as ConfigurationStatus,invalidatedAt,observedAt};}
    catch{return {invalidatedAt,observedAt};}
}
export async function latestConfigurationStatus(pool:Pool,email:string,scope:ConfigurationStatusScope):Promise<ConfigurationStatus|undefined>{return (await readConfigurationState(pool,email,scope)).status;}

/** Ревизии не являются хэшами секретов и не переносят настройки между инструментами графа. */
export async function configurationRevisionsForProbe(pool:Pool,email:string,scope:{deviceId:string;projectId:string;bindingId:string;instanceId:string;packages:IPackage[]}):Promise<ConfigurationRevision[]>{
    const configured=scope.packages.filter(pkg=>configurationSchemaDigest(pkg));const result:ConfigurationRevision[]=[];
    for(const pkg of configured){
        const status=await latestConfigurationStatus(pool,email,{...scope,package:pkg});
        if(!status?.ready)throw new ConflictException(`Задайте параметры MCP «${pkg.plugin.name}» на компьютере и обновите статус настройки.`);
        result.push({assetId:pkg.plugin.id,manifest:pkg.manifest.sha256,revision:status.revision});
    }
    return result.sort((a,b)=>a.assetId===b.assetId?0:a.assetId<b.assetId?-1:1);
}
export async function assertRuntimeConfigurationRevisions(pool:Pool,email:string,deviceId:string,projectId:string,payload:Record<string,unknown>){
    const pkg=payload.package as IPackage;const packages=(payload.installSet as {packages:IPackage[]}|undefined)?.packages??[pkg];
    if(!packages.some(member=>configurationSchemaDigest(member)))return;
    const revisions=await configurationRevisionsForProbe(pool,email,{deviceId,projectId,bindingId:String(payload.bindingId),instanceId:String(payload.instanceId),packages});
    if(!validConfigurationRevisions(payload.configurationRevisions)||!isDeepStrictEqual(revisions,payload.configurationRevisions))throw new ConflictException('Настройка MCP изменилась. Обновите статус и подтвердите диагностику заново.');
}
