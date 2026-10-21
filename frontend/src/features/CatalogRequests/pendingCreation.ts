import {requestPayload} from './model';
import type {IRequestCreate} from './types';

export interface IPendingCreation {schemaVersion:1;key:string;payload:IRequestCreate}
const prefix='neurocenter.catalog-request.pending.';
export const pendingCreationKey=(scope:string):string=>prefix+encodeURIComponent(scope);

/** One explicit unconfirmed submission survives tab switches and reloads, scoped to current access. */
export function readPendingCreation(scope:string):IPendingCreation|null {
    let raw:string|null;
    try{raw=sessionStorage.getItem(pendingCreationKey(scope));}catch{throw new Error('Не удалось проверить предыдущую отправку. Разрешите хранилище этой вкладки и повторите проверку.');}
    if(raw===null)return null;
    try{
        const value=JSON.parse(raw) as Partial<IPendingCreation>;
        if(value.schemaVersion!==1||typeof value.key!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.key)||!value.payload||!['add','update','issue'].includes(value.payload.kind)||!['plugin','mcp','skill','model'].includes(value.payload.assetType))throw new Error('format');
        return {schemaVersion:1,key:value.key,payload:requestPayload(value.payload)};
    }catch{throw new Error('Сохранённая отправка повреждена. Новая заявка не отправлена. Проверьте «Мои заявки»; восстановите данные хранилища этой вкладки перед повтором.');}
}

/** Storage must acknowledge the exact intent before POST; unavailable storage cannot cause an untracked write. */
export function savePendingCreation(scope:string,value:IPendingCreation):void {
    const old=readPendingCreation(scope);
    if(old&&(old.key!==value.key||JSON.stringify(old.payload)!==JSON.stringify(requestPayload(value.payload))))throw new Error('Сначала проверьте или повторите предыдущую отправку.');
    try{sessionStorage.setItem(pendingCreationKey(scope),JSON.stringify(value));}catch{throw new Error('Не удалось сохранить запрос в этой вкладке. Заявка не отправлена: освободите место или разрешите хранилище.');}
}

export function clearPendingCreation(scope:string,key:string):void {
    const old=readPendingCreation(scope);if(!old)return;
    if(old.key!==key)throw new Error('В этой вкладке уже другая неподтверждённая отправка. Её данные сохранены.');
    try{sessionStorage.removeItem(pendingCreationKey(scope));}catch{throw new Error('Приём заявки подтверждён, но хранилище вкладки не разрешило очистку. Повторите проверку.');}
}
