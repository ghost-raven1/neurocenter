import type {IBridgeDevice,IBridgeInstallation} from '../api';
import type {IBridgeBinding} from '../operationTypes';
import type {IRagUiDraft} from './ragUiState';

export interface IRagUiPreference {owner:string;root:string;request:IRagUiDraft;}
export const ragUiAnchorId=(projectId:string):string=>'opencode-rag-ui-'+projectId;
export const ragUiPreferenceKey=(value:IRagUiPreference):string=>JSON.stringify([value.owner,value.root,value.request]);

/** Предпочтение не переносится на соседний пакет, компьютер или экземпляр папки. */
export function matchesRagUiPreference(item:IBridgeInstallation,value:IRagUiPreference):boolean {
    const request=value.request;
    return item.deviceId===request.deviceId&&item.projectId===request.projectId&&item.bindingId===request.expectedBindingId
        &&item.assetKind===request.assetKind&&item.assetId===request.assetId&&item.version===request.version&&item.manifest===request.expectedManifest;
}
export function ragUiPreferenceBlocker(value:IRagUiPreference,owner:string,projectId:string,device:IBridgeDevice|undefined,binding:IBridgeBinding|undefined):string {
    if(value.owner!==owner||value.request.projectId!==projectId)return 'Выбор установки относится к другой сессии или проекту. Выберите установку заново.';
    if(device?.id!==value.request.deviceId)return 'Модель подключена на другом компьютере. Выберите его в подключении моста или явно выберите другую установку.';
    if(device.report.root!==value.root||binding?.bindingId!==value.request.expectedBindingId||binding.instanceId!==value.request.expectedInstanceId)
        return 'Папка подключённой установки изменилась. Проверьте привязку и явно выберите установку заново.';
    return '';
}
