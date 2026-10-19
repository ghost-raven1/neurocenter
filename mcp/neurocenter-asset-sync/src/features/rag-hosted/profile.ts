import fs from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {hash,hub} from '../../bridge/state.js';
import {verify,type Package} from '../../bridge/package.js';
import {projectFolder,projectBindingId,projectInstanceId} from '../../bridge/workspace.js';
import {inspectInstallation} from '../../bridge/installation-inspection.js';
import {readPrivateConfiguration} from '../local-configuration/private-store.js';
export interface HostedSelection {revision:number;modelPin:string;profile:{provider:'openai';model:string;dimension:number};model:unknown}
export interface HostedProfile {schemaVersion:1;server:string;root:string;projectId:string;bindingId:string;instanceId:string;pkg:Package;selection:HostedSelection;relay:{port:number;key:string}}
export const profileKey=(server:string,root:string,instanceId:string):string=>hash(JSON.stringify([server,root,instanceId]));
export function validateSelection(value:HostedSelection):void {
    if(!value||!Number.isSafeInteger(value.revision)||value.revision<1||!/^[a-f0-9]{64}$/.test(value.modelPin)
        ||value.profile?.provider!=='openai'||!Number.isSafeInteger(value.profile.dimension)||value.profile.dimension<1||value.profile.dimension>65535
        ||!/^neurocenter\/[A-Za-z0-9._-]+\/sha256\/[a-f0-9]{64}$/.test(value.profile.model)||!value.profile.model.endsWith('/'+value.modelPin))throw new Error('Выбранная серверная модель не подтверждена. Обновите настройку проекта.');
}
/** Удаление, смена версии и перенос папки немедленно закрывают доступ к relay. */
export async function assertHostedInstallation(profile:HostedProfile):Promise<void> {
    validateSelection(profile.selection);verify(profile.pkg);
    if(profile.schemaVersion!==1||profile.server!==hub()||!['mcp','plugin'].includes(profile.pkg.plugin.kind)
        ||(profile.pkg.config?.extra?.hostedEmbedding as {schemaVersion?:unknown}|undefined)?.schemaVersion!==1
        ||await projectFolder(profile.projectId)!==profile.root||await projectBindingId(profile.projectId)!==profile.bindingId||await projectInstanceId(profile.projectId)!==profile.instanceId)throw new Error('Привязка или версия OpenCodeRAG изменилась. Подключите модель повторно.');
    const inspection=await inspectInstallation(profile.projectId,profile.pkg);
    if(inspection.state!=='checked'||inspection.status!=='synced')throw new Error('Сначала проверьте или восстановите установленный OpenCodeRAG.');
}
export function sameSelection(a:HostedSelection,b:HostedSelection):boolean{return a.revision===b.revision&&a.modelPin===b.modelPin&&isDeepStrictEqual(a.profile,b.profile);}
/** Публичное представление содержит только identity индекса, без локального или серверного секрета. */
export async function readHostedRagEmbedding(root:string,projectId?:string):Promise<{provider:'openai';model:string;baseUrl:string;vectorDimension:number}|undefined> {
    const real=await fs.realpath(root);let marker:{projectId?:string;instanceId?:string;server?:string};
    try{marker=JSON.parse(await fs.readFile(real+'/.opencode/neurocenter.json','utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    if(!marker.instanceId||marker.server!==hub()||projectId&&marker.projectId!==projectId)return undefined;
    const value=await readPrivateConfiguration<HostedProfile>(profileKey(hub(),real,marker.instanceId));if(!value)return undefined;
    await assertHostedInstallation(value);
    if(!Number.isInteger(value.relay?.port)||value.relay.port<1||value.relay.port>65535||!/^[a-f0-9]{64}$/.test(value.relay.key))throw new Error('Приватное подключение RAG повреждено. Подключите модель повторно.');
    return {provider:'openai',model:value.selection.profile.model,baseUrl:`http://127.0.0.1:${value.relay.port}/v1`,vectorDimension:value.selection.profile.dimension};
}
