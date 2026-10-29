import {normalizeOpenCodeCliRequest} from '@neurocenter/computer-setup';
import {roleLevel} from '../UserBlock/roles';
import {cliUuid,record,type CliIntent} from './model';

export type CliStorage=Pick<Storage,'getItem'|'setItem'>;
export const cliStorageKey=(email:string,deviceId:string):string=>'neurocenter.opencode-cli.'+encodeURIComponent(JSON.stringify([email.trim().toLowerCase(),deviceId]));
const damaged=():Error=>Error('Сохранённая отправка OpenCode не прочитана. Обновите историю; новая проверка приостановлена, исходные данные сохранены.');

/** A corrupt or unavailable journal never becomes an empty new request. */
export function readCliIntent(storage:Pick<Storage,'getItem'>,key:string,email:string,deviceId:string):{intent?:CliIntent;raw:string|null}{
    const raw=storage.getItem(key);if(raw===null)return {raw};
    if(raw.length>4096)throw damaged();
    let value:unknown;try{value=JSON.parse(raw);}catch{throw damaged();}
    if(!record(value)||value.version!==1||value.email!==email.trim().toLowerCase()||typeof value.role!=='string'||roleLevel(value.role)<1
        ||Object.keys(value).some(key=>!['version','email','role','request','jobId'].includes(key))||value.jobId!==undefined&&!cliUuid(value.jobId))throw damaged();
    let request;try{request=normalizeOpenCodeCliRequest(value.request);}catch{throw damaged();}
    if(request.deviceId!==deviceId)throw damaged();
    const jobId=typeof value.jobId==='string'?value.jobId:undefined;
    return {raw,intent:{version:1,email:value.email,role:value.role,request,...(jobId?{jobId}:{})}};
}

/** Compare observed bytes before replacing them; this is not an atomic cross-tab transaction. */
export function writeCliIntent(storage:CliStorage,key:string,intent:CliIntent,observedRaw:string|null):string{
    if(storage.getItem(key)!==observedRaw)throw Error('Сохранённая отправка изменена в другой вкладке. Обновите состояние; исходный запрос сохранён.');
    const raw=JSON.stringify(intent);if(raw!==observedRaw)storage.setItem(key,raw);
    if(storage.getItem(key)!==raw)throw Error('Не удалось подтвердить сохранение отправки. Обновите состояние перед повтором.');
    return raw;
}
