import type {IBridgeDevice} from '../McpBridge/api';
import {sha,uuid} from '../McpBridge/operationHelpers';
import {workspaceBlocker} from '../McpBridge/readiness';
/** Capture targets exactly one verified current folder on the selected, freshly observed computer. */
export function snapshotCaptureTarget(projectId:string,device:IBridgeDevice|undefined,devicesReady:boolean):{reason:string;bindingId?:string;folderName?:string}{
    if(!devicesReady)return {reason:'Обновите сведения о компьютере и дождитесь актуального подключения.'};
    const reason=workspaceBlocker(device);if(reason)return {reason};
    if(device?.report.rootError)return {reason:device.report.rootError};
    if(!device?.report.capabilities?.includes('project-snapshots-v1'))return {reason:'Обновите мост на странице «Начало работы»: для полного снимка нужна поддержка project-snapshots-v1.'};
    const bindings=device.report.bindings?.filter(item=>item.projectId===projectId)??[];
    if(bindings.length!==1)return {reason:bindings.length?'У проекта несколько папок на этом компьютере. Оставьте одну действующую привязку перед созданием снимка.':'Сначала свяжите папку этого проекта с выбранным компьютером.'};
    const binding=bindings[0];
    if(binding.valid!==true||binding.identityStatus!=='verified'||!sha(binding.bindingId)||!uuid(binding.instanceId)||binding.error||!binding.folderName?.trim())return {reason:'Привязка папки не подтверждена. Проверьте её на странице «Проекты».'};
    return {reason:'',bindingId:binding.bindingId,folderName:binding.folderName};
}
