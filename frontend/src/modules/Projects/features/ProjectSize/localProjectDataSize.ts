import type {IBridgeDevice} from '../../../../features/McpBridge/api';
import {projectBindingUrl} from '../../projectNavigation';

const MAX_AGE_MS = 60000;
const MAX_CLOCK_SKEW_MS = 5000;
const bindingId = /^[a-f0-9]{64}$/;
const instanceId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const knownBytes = (value:unknown):value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export interface IProjectDataSizeView {
    bytes:unknown;
    source:'server'|'local';
    label?:string;
    error?:string;
    description?:string;
    sourceLabel?:string;
    expiresAt?:number;
    action?:{label:string;href:string};
}
interface IInput {
    projectId:string;
    serverBytes:unknown;
    serverError?:string;
    device?:IBridgeDevice;
    devices?:IBridgeDevice[];
    devicesReady:boolean;
    loading?:boolean;
    canRead:boolean;
    canBind:boolean;
    now?:number;
}

/** A local measurement belongs to the selected verified folder; a server root never substitutes for it. */
export function projectDataSize({projectId,serverBytes,serverError,device,devices=[],devicesReady,loading=false,canRead,canBind,now=Date.now()}:IInput):IProjectDataSizeView {
    const server:IProjectDataSizeView = {bytes:serverBytes,error:serverError,source:'server'};
    if (!canRead) return {bytes:null,source:'local',label:'Нет доступа',description:'Доступ к данным проекта не подтверждён.'};
    if (!devicesReady) return {bytes:null,source:'local',label:loading?'Проверяем размер…':'Данные не подтверждены',description:'Подключение выбранного компьютера ещё не подтверждено. Обновите данные перед измерением.'};
    const bindings = Array.isArray(device?.report.bindings) ? device.report.bindings.filter(item=>item?.projectId===projectId) : [];
    const action = canBind ? {label:'Связать папку',href:projectBindingUrl(projectId)} : undefined;
    if (!device) {
        if (!devices.length && knownBytes(serverBytes)) return {...server,sourceLabel:'На сервере'};
        return {bytes:null,source:'local',label:'Выберите компьютер',description:'Выберите подключённый компьютер, чтобы измерить данные локальной папки.',action:{label:'Выбрать компьютер',href:projectBindingUrl(projectId)}};
    }
    const local = (label:string,description:string,extra:Partial<IProjectDataSizeView>={}):IProjectDataSizeView =>
        ({bytes:null,source:'local',label,description,sourceLabel:`На «${device.name}»`,...extra});
    if (!device.online || device.requiresReconnect) return local('Компьютер недоступен','Подключите выбранный компьютер и обновите данные.',{action:{label:'Проверить компьютер',href:'/start?step=1'}});
    if (!bindings.length && knownBytes(serverBytes)) return {...server,sourceLabel:'На сервере'};
    if (!bindings.length) return local('Папка не связана',canBind ? 'Свяжите папку этого проекта с выбранным компьютером для измерения её данных.' : 'Папка проекта на выбранном компьютере ещё не связана. Её может связать разработчик или администратор проекта.',{action});
    const binding = bindings[0];
    if (bindings.length!==1 || binding.valid!==true || binding.identityStatus!=='verified'
        || typeof binding.bindingId!=='string' || !bindingId.test(binding.bindingId)
        || typeof binding.instanceId!=='string' || !instanceId.test(binding.instanceId)) {
        return local('Проверьте привязку','Папка проекта не подтверждена. Проверьте её привязку перед измерением.',{action:canBind?{label:'Проверить привязку',href:projectBindingUrl(projectId)}:undefined});
    }
    if (!Array.isArray(device.report.capabilities) || !device.report.capabilities.includes('project-data-size-v1')) return local('Обновите мост','Обновите мост на выбранном компьютере: установленная версия не передаёт размер данных проекта.',{action:{label:'Подключение компьютера',href:'/start?step=1'}});
    const size = binding.dataSize;
    if (size===undefined) return local('Измеряем…','Компьютер ещё не передал первый замер. Данные обновятся автоматически.');
    if (!size || size.scope!=='opencode' || typeof size.measuredAt!=='string') return local('Замер недоступен','Компьютер передал неполные сведения о размере. Обновите данные.');
    const measured = Date.parse(size.measuredAt), age = now-measured;
    if (!Number.isFinite(measured) || new Date(measured).toISOString()!==size.measuredAt || age < -MAX_CLOCK_SKEW_MS) return local('Замер недоступен','Время измерения не подтверждено. Проверьте часы компьютера и обновите данные.');
    if (age > MAX_AGE_MS) return local('Замер устарел','Размер давно не измерялся. Подключите компьютер и обновите данные.');
    if (size.bytes===null && ['unavailable','limit-exceeded'].includes(size.error??'')) return local('Размер не измерен',size.error==='limit-exceeded'
        ? 'Фоновый замер не завершён: достигнут лимит чтения папки. Повторите измерение после завершения работы с данными.'
        : 'Не удалось прочитать данные папки. Проверьте доступ на выбранном компьютере и повторите измерение.');
    if (!knownBytes(size.bytes) || size.error!==undefined) return local('Замер недоступен','Компьютер передал неполные сведения о размере. Обновите данные.');
    return {bytes:size.bytes,source:'local',sourceLabel:`На «${device.name}»`,description:`Размер файлов .opencode в папке «${binding.folderName}» на компьютере «${device.name}».`,expiresAt:measured+MAX_AGE_MS+1};
}
