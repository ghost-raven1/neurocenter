import type { IRequestAssetType, IRequestKind, IRequestStatus } from './types';

export const requestKinds: Array<{value:IRequestKind;label:string}> = [
    {value:'add',label:'Добавить в каталог'}, {value:'update',label:'Обновить'}, {value:'issue',label:'Сообщить о проблеме'},
];
export const requestAssets: Array<{value:IRequestAssetType;label:string}> = [
    {value:'plugin',label:'Плагин'}, {value:'mcp',label:'MCP'}, {value:'skill',label:'Скилл'}, {value:'model',label:'Модель'},
];
export const requestStates: Record<IRequestStatus,{label:string;color:string}> = {
    submitted:{label:'Новая',color:'blue'}, in_progress:{label:'В работе',color:'processing'},
    needs_info:{label:'Нужно уточнить',color:'orange'}, completed:{label:'Выполнена',color:'green'},
    rejected:{label:'Отклонена',color:'red'}, cancelled:{label:'Отменена',color:'default'},
};
export const requestKindLabel = (value:IRequestKind):string => requestKinds.find(item=>item.value===value)?.label ?? value;
export const requestAssetLabel = (value:IRequestAssetType):string => requestAssets.find(item=>item.value===value)?.label ?? value;

/** Intake accepts references as text only; no metadata requests or downloads are started. */
export function requestSourceUrl(value:string|undefined|null):string|null {
    if(!value?.trim())return null;
    let parsed:URL;
    try{parsed=new URL(value.trim());}catch{throw new Error('Укажите полный адрес http:// или https://.');}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('Нужен HTTP(S)-адрес без логина и пароля.');
    if(value.length>2048)throw new Error('Ссылка должна быть не длиннее 2048 символов.');
    return parsed.href;
}

export function requestTime(value:string):string {
    const date=new Date(value);
    return Number.isNaN(date.getTime())?'Дата недоступна':date.toLocaleString('ru-RU');
}
