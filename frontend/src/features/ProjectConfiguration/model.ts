import type {useBridge} from '../McpBridge/useBridge';
import {bridgeOperationBlocker} from '../McpBridge/readiness';
import {roleLevel} from '../UserBlock/roles';
export const PROJECT_CONFIGURATION_JOB='open-project-configuration';
/** An editor session is pinned to one current workspace instance and requires an admin bridge. */
export function configurationTarget(bridge:ReturnType<typeof useBridge>,projectId:string,admin:boolean){
    if(!admin)return {reason:'Редактировать файлы конфигурации может администратор проекта.'};
    if(!bridge.devicesReady)return {reason:bridge.errors.devices||'Дождитесь проверки компьютера.'};
    const common=bridgeOperationBlocker(bridge.device);if(common)return {reason:common};
    const device=bridge.device!;
    if(!device.online)return {reason:'Включите компьютер, чтобы открыть локальный редактор.'};
    if(roleLevel(device.role)<3)return {reason:'Подключите мост с ролью администратора.'};
    if(!device.report.capabilities?.includes('project-configuration-v1'))return {reason:'Обновите мост для локального редактора конфигурации.'};
    const binding=device.report.bindings?.find(item=>item.projectId===projectId&&item.valid!==false);
    if(!binding?.bindingId||!binding.instanceId)return {reason:'Сначала свяжите папку проекта на этом компьютере.'};
    if(!bridge.jobsReady)return {reason:bridge.errors.jobs||'Дождитесь загрузки заданий.'};
    return {reason:'',target:{deviceId:device.id,projectId,expectedBindingId:binding.bindingId,expectedInstanceId:binding.instanceId}};
}
