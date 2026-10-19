import { ConflictException } from '@nestjs/common';
import { parseLocalConfiguration, localConfigurationDigest } from './mcp-config-schema';
import type { IPackage } from '../catalog/bundle-package';

export const CONFIGURATION_KINDS = ['prepare-mcp-configuration','open-mcp-configuration','get-mcp-configuration-status'];
export const configurationRead = (kind:string) => kind === 'get-mcp-configuration-status';
export interface ConfigurationRevision {assetId:string;manifest:string;revision:string|null}
export interface ConfigurationTuple {
    schemaVersion:1;projectId:string;bindingId:string;instanceId:string;assetId:string;assetKind:'mcp';version:number;manifest:string;schemaDigest:string;
}
export interface ConfigurationStatus extends ConfigurationTuple {ready:boolean;missingFieldIds:string[];revision:string|null;checkedAt:string}
interface Source {projectId:string|null;bindingId?:unknown;instanceId?:unknown;package?:IPackage;schemaDigest?:unknown;configurationPreparationId?:unknown}
const base = ['schemaVersion','projectId','bindingId','instanceId','assetId','assetKind','version','manifest','schemaDigest'];
export const configurationUuid = (value:unknown):value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const iso = (value:unknown):value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function configurationSchemaDigest(pkg:IPackage):string|undefined {
    const schema=parseLocalConfiguration(pkg);return schema ? localConfigurationDigest(schema) : undefined;
}

/** Сервер принимает только готовность и случайные ревизии; значения и отпечатки секретов запрещены. */
export function assertConfigurationReport(kind:string,value:unknown,source:Source,failed=false):asserts value is ConfigurationTuple & Record<string,unknown> {
    const fail=()=>{throw new ConflictException('Результат настройки содержит неподдерживаемые данные или относится к другой установке.');};
    if(!value || typeof value!=='object' || Array.isArray(value))return fail();
    const item=value as Record<string,unknown>;
    if(failed){if(Object.keys(item).length)return fail();return;}
    const fields=[...base,...(kind==='prepare-mcp-configuration'?['preparationId','expiresAt']:kind==='open-mcp-configuration'?['preparationId','opened','expiresAt']:['ready','missingFieldIds','revision','checkedAt'])];
    const schema=source.package && parseLocalConfiguration(source.package);
    if(!schema || Object.keys(item).length!==fields.length || Object.keys(item).some(key=>!fields.includes(key))
        || item.schemaVersion!==1 || item.projectId!==source.projectId || item.bindingId!==source.bindingId || item.instanceId!==source.instanceId
        || item.assetKind!=='mcp' || item.assetId!==source.package!.plugin.id || item.version!==source.package!.plugin.version
        || item.manifest!==source.package!.manifest.sha256 || item.schemaDigest!==localConfigurationDigest(schema)
        || source.schemaDigest!==undefined && item.schemaDigest!==source.schemaDigest)return fail();
    if(kind==='get-mcp-configuration-status'){
        if(typeof item.ready!=='boolean' || !Array.isArray(item.missingFieldIds) || item.missingFieldIds.length>32
            || item.missingFieldIds.some(id=>typeof id!=='string'||!schema.fields.some(field=>field.id===id&&field.required))
            || new Set(item.missingFieldIds).size!==item.missingFieldIds.length || item.revision!==null&&!configurationUuid(item.revision)
            || item.ready !== (item.missingFieldIds.length===0)
            || !iso(item.checkedAt) || Date.parse(item.checkedAt)>Date.now()+60_000)return fail();
    }else if(!configurationUuid(item.preparationId) || !iso(item.expiresAt) || Date.parse(item.expiresAt)>Date.now()+16*60_000
        || kind==='open-mcp-configuration'&&(item.opened!==true||item.preparationId!==source.configurationPreparationId))return fail();
}

/** Ревизии привязаны ко всем настраиваемым MCP внутри одобренного графа. */
export function validConfigurationRevisions(value:unknown):value is ConfigurationRevision[] {
    return Array.isArray(value)&&value.length<=20&&value.every((item,index)=>item&&typeof item==='object'&&!Array.isArray(item)
        &&Object.keys(item).length===3&&Object.keys(item).every(key=>['assetId','manifest','revision'].includes(key))
        &&typeof item.assetId==='string'&&item.assetId.length>0&&item.assetId.length<=500&&/^[a-f0-9]{64}$/.test(item.manifest)
        &&(item.revision===null||configurationUuid(item.revision))&&(index===0||value[index-1].assetId<item.assetId));
}
