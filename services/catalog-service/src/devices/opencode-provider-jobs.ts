import {BadRequestException,ConflictException,ServiceUnavailableException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {normalizeProviderDescriptor,normalizeProviderReport,OPENCODE_PROVIDER_CAPABILITY,OPENCODE_PROVIDER_JOBS,type OpenCodeProviderDescriptor} from '../../../shared/opencode-providers.cjs';
import {modelFromRow,type IModelRow} from '../models/model-history';
import {remoteModelBaseUrl} from '../models/remote-model-validation';
import {remoteModelOptions} from '../models/remote-model-options';
import {verifyPackage,type IPackage} from '../catalog/bundle-package';
import type {Device,DeviceStore} from './device-store';
import type {DeviceArtifacts} from './device-artifacts';
import type {Job,JobInput} from './device-job.model';
import {assertExpectedBinding,managedBinding,assertPackageBridge} from './device-compatibility';
import {assertLocalFeature} from './local-change-jobs';
import {publishedCodexConnectors} from '../package-build/codex-connector-build';

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inputKeys=['deviceId','projectId','kind','requestKey','expectedBindingId','expectedInstanceId','providerKind','catalogModelId','expectedModelPin','preparationJobId','expectedProviderSchemaDigest'];
export const isProviderJob=(kind:string)=>OPENCODE_PROVIDER_JOBS.includes(kind as never);

function binding(device:Device,input:Pick<JobInput,'projectId'|'expectedBindingId'|'expectedInstanceId'>){
    assertLocalFeature(device.report,OPENCODE_PROVIDER_CAPABILITY);
    const bindingId=managedBinding(device.report,input.projectId);assertExpectedBinding(bindingId,input.expectedBindingId,true);
    const found=(device.report.bindings as Array<{projectId:string;instanceId?:string}>).find(item=>item.projectId===input.projectId);
    if(!uuid(input.expectedInstanceId)||found?.instanceId!==input.expectedInstanceId)throw new ConflictException('Экземпляр папки изменился. Откройте настройку заново.');
    return {bindingId,instanceId:input.expectedInstanceId};
}

/** Only a server-built, pinned auth-only connector may enter a native job; browser references are never accepted. */
async function connector(store:DeviceStore,artifacts:DeviceArtifacts):Promise<IPackage>{
    let pin:{schemaVersion:number;repository:string;sourceCommit:string;version:string;sdkVersion:string;authOnly:boolean};
    try{pin=JSON.parse(await readFile(path.resolve(__dirname,'../../../shared/codex-connector-pin.json'),'utf8'));}
    catch{throw new ServiceUnavailableException('Закреплённый коннектор Codex ещё не подготовлен на площадке.');}
    if(pin.schemaVersion!==1||pin.authOnly!==true||typeof pin.repository!=='string'||!/^https:\/\/github.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(pin.repository)
        ||!/^[a-f0-9]{40}$/.test(pin.sourceCommit)||!/^\d+\.\d+\.\d+$/.test(pin.version)||!/^\d+\.\d+\.\d+$/.test(pin.sdkVersion))throw new ServiceUnavailableException('Опись коннектора Codex повреждена.');
    const rows=await publishedCodexConnectors(store.pool,pin);
    if(rows.length!==1)throw new ConflictException('Подготовьте единственную закреплённую поставку коннектора Codex в упаковщике.');
    const pkg=await artifacts.build('plugin',rows[0].id,Number(rows[0].version)),metadata=pkg.config?.extra?.codexConnector as Record<string,unknown>|undefined;
    if(!verifyPackage(pkg)||pkg.plugin.kind!=='plugin'||!Array.isArray(pkg.config?.extra?.runtimeArtifacts)||!pkg.config.extra.runtimeArtifacts.length||metadata?.schemaVersion!==1
        ||metadata.sourceCommit!==pin.sourceCommit||metadata.version!==pin.version||metadata.sdkVersion!==pin.sdkVersion||metadata.authOnly!==true)throw new ConflictException('Пакет коннектора не соответствует закреплённому источнику.');
    return pkg;
}

/** Read only non-secret model identity and endpoint; server credential columns are never selected. */
async function descriptor(store:DeviceStore,artifacts:DeviceArtifacts,device:Device,input:JobInput){
    const current=binding(device,input);let expectations:OpenCodeProviderDescriptor['expectations']=null,pkg:IPackage|undefined;
    if(input.providerKind==='openai-compatible'){
        if(typeof input.catalogModelId!=='string'||!sha(input.expectedModelPin))throw new BadRequestException('Выберите модель и актуальный pin.');
        const row=(await store.pool.query<IModelRow>(`SELECT c.* FROM model_catalog c JOIN project_models p ON p.model_id=c.id
            WHERE c.id=$1 AND p.project_id=$2 AND c.archived_at IS NULL`,[input.catalogModelId,input.projectId])).rows[0];
        if(!row)throw new ConflictException('Модель больше не назначена проекту.');
        const model=modelFromRow(row);
        if(model.runtime!=='remote-openai'||!['chat','vision'].includes(model.capability)||model.modelPin!==input.expectedModelPin||!model.verificationSha256)throw new ConflictException('Выберите актуальную проверенную OpenAI-совместимую модель чата.');
        const connection=(await store.pool.query<{base_url:string;options:unknown}>(`SELECT base_url,options FROM model_remote_connections
            WHERE model_id=$1 AND semantic_sha=$2 AND revoked_at IS NULL ORDER BY revision DESC LIMIT 1`,[model.id,model.verificationSha256])).rows[0];
        if(!connection)throw new ConflictException('Подключение модели изменилось. Проверьте API модели.');
        const saved=remoteModelOptions(connection.options),options=Object.fromEntries(['temperature','topP','maxOutputTokens','contextWindow'].flatMap(key=>saved[key as keyof typeof saved]===undefined?[]:[[key,saved[key as keyof typeof saved]]]));
        expectations={catalogModelId:model.id,modelPin:model.modelPin!,runtimeModel:model.model,capability:model.capability as 'chat'|'vision',baseUrl:remoteModelBaseUrl(connection.base_url),options};
    }else if(input.providerKind==='codex-bridge'){
        if(input.catalogModelId!==undefined||input.expectedModelPin!==undefined)throw new BadRequestException('Codex использует закреплённый коннектор, а не клиентскую модель.');
        pkg=await connector(store,artifacts);assertPackageBridge(device.report,pkg);
    }else throw new BadRequestException('Неизвестный вид провайдера.');
    const context={schemaVersion:1,deviceId:device.id,projectId:input.projectId!,...current,providerKind:input.providerKind,
        providerId:'neurocenter-'+(expectations?'openai':'codex')+'-'+hash([input.projectId,input.providerKind,input.catalogModelId??null]).slice(0,16),
        expectations,connector:pkg?{assetId:pkg.plugin.id,version:pkg.plugin.version,manifest:pkg.manifest.sha256,sourceCommit:(pkg.config!.extra!.codexConnector as {sourceCommit:string}).sourceCommit}:null};
    try{return {descriptor:normalizeProviderDescriptor({...context,schemaDigest:hash(context)}),...(pkg?{connectorPackage:pkg}:{})};}
    catch{throw new ConflictException('Модель или поставка не поддерживается текущим форматом OpenCode.');}
}

async function preparation(store:DeviceStore,device:Device,expected:OpenCodeProviderDescriptor,id:unknown){
    if(!uuid(id))throw new BadRequestException('Выберите подготовку настройки.');
    const row=(await store.pool.query<{result:unknown;role:string}>(`SELECT result,role FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND email=$3
        AND project_id=$4 AND kind='prepare-opencode-provider' AND state='succeeded'`,[id,device.id,device.email,expected.projectId])).rows[0];
    if(!row)throw new ConflictException('Подготовка провайдера не найдена в этом профиле.');
    let report;try{report=normalizeProviderReport('prepare-opencode-provider',row.result,expected) as {preparationId:string;expiresAt:string};}
    catch{throw new ConflictException('Подготовка относится к другой модели или папке.');}
    if(Date.parse(report.expiresAt)<=Date.now())throw new ConflictException('Срок настройки истёк. Откройте мастер заново.');
    return {...report,role:row.role};
}

/** Browser supplies identifiers only; descriptor and executable package always come from the server. */
export async function providerJobPayload(store:DeviceStore,artifacts:DeviceArtifacts,device:Device,input:JobInput,role:string){
    if(!isProviderJob(input.kind))return undefined;
    if(Object.keys(input).some(key=>!inputKeys.includes(key)))throw new BadRequestException('Настройка принимает только идентификаторы, без локальных значений.');
    const result=await descriptor(store,artifacts,device,input),d=result.descriptor;
    const payload:Record<string,unknown>={...result,bindingId:d.bindingId,instanceId:d.instanceId};
    if(input.kind==='open-opencode-provider'){
        if(input.expectedProviderSchemaDigest!==d.schemaDigest)throw new ConflictException('Схема провайдера изменилась.');
        const prepared=await preparation(store,device,d,input.preparationJobId);
        if(prepared.role!==role)throw new ConflictException('Роль подготовки изменилась.');
        Object.assign(payload,{preparationJobId:input.preparationJobId,preparationId:prepared.preparationId,expiresAt:prepared.expiresAt});
    }else if(input.preparationJobId!==undefined||input.expectedProviderSchemaDigest!==undefined)throw new BadRequestException('Подготовка нужна только для открытия мастера.');
    return payload;
}

/** Every lease and standalone form permit reconstructs current assignment, endpoint, pin and physical folder. */
export async function assertProviderJob(store:DeviceStore,artifacts:DeviceArtifacts,device:Device,job:Pick<Job,'kind'|'payload'|'project_id'|'role'>,allowExpired=false){
    if(!isProviderJob(job.kind))return;
    let d;try{d=normalizeProviderDescriptor(job.payload.descriptor);}catch{throw new ConflictException('Контекст провайдера повреждён.');}
    const live=await descriptor(store,artifacts,device,{kind:job.kind,requestKey:'',deviceId:device.id,projectId:job.project_id??undefined,expectedBindingId:d.bindingId,
        expectedInstanceId:d.instanceId,providerKind:d.providerKind,...d.expectations?{catalogModelId:d.expectations.catalogModelId,expectedModelPin:d.expectations.modelPin}:{}});
    if(!isDeepStrictEqual(live.descriptor,d)||job.payload.bindingId!==d.bindingId||job.payload.instanceId!==d.instanceId)throw new ConflictException('Настройка модели, коннектора или папки изменилась.');
    if(job.kind==='open-opencode-provider'&&!allowExpired){
        const prepared=await preparation(store,device,d,job.payload.preparationJobId);
        if(prepared.role!==job.role||prepared.preparationId!==job.payload.preparationId||prepared.expiresAt!==job.payload.expiresAt)throw new ConflictException('Сессия мастера изменилась.');
    }
}
