export type RemoteAuthMode='none'|'optional'|'required';
export interface PersonalProviderView {modelId:string;providerId:string;providerUrl:string;connectionRevision:number;authMode:RemoteAuthMode;credentialRevision:number;hasKey:boolean;updatedAt:string|null;canStoreKey:boolean;legacySharedKeyRetained:boolean;}
export interface PersonalProviderIntent {version:1;action:'save'|'delete';providerId:string;expectedConnectionRevision:number;expectedCredentialRevision:number;requestKey:string;}
export interface PersonalProviderReceipt {modelId:string;providerId:string;requestKey:string;requestHash:string;connectionRevision:number;credentialRevision:number;hasKey:boolean;acceptedAt:string;}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const integer=(value:unknown,minimum=0)=>Number.isSafeInteger(value)&&Number(value)>=minimum;
const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
export function personalProviderView(value:unknown,modelId:string):PersonalProviderView {
    if(!object(value)||!exact(value,['modelId','providerId','providerUrl','connectionRevision','authMode','credentialRevision','hasKey','updatedAt','canStoreKey','legacySharedKeyRetained'])||value.modelId!==modelId||!sha(value.providerId)||typeof value.providerUrl!=='string'
        ||!integer(value.connectionRevision,1)||!integer(value.credentialRevision)||typeof value.authMode!=='string'||!['none','optional','required'].includes(value.authMode)
        ||typeof value.hasKey!=='boolean'||typeof value.canStoreKey!=='boolean'||typeof value.legacySharedKeyRetained!=='boolean'
        ||!(value.updatedAt===null||date(value.updatedAt)))throw Error('Сервер не подтвердил личный доступ к провайдеру.');
    let url:URL;try{url=new URL(value.providerUrl);}catch{throw Error('Адрес провайдера не подтверждён.');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Адрес провайдера не подтверждён.');
    return value as unknown as PersonalProviderView;
}
export function personalProviderIntent(value:unknown):PersonalProviderIntent {
    if(!object(value)||Object.keys(value).sort().join(',')!=='action,expectedConnectionRevision,expectedCredentialRevision,providerId,requestKey,version'
        ||value.version!==1||typeof value.action!=='string'||!['save','delete'].includes(value.action)||!sha(value.providerId)||!uuid(value.requestKey)
        ||!integer(value.expectedConnectionRevision,1)||!integer(value.expectedCredentialRevision))throw Error('Журнал личного доступа повреждён. Сохранённые данные не изменены; новая настройка приостановлена.');
    return value as unknown as PersonalProviderIntent;
}
export function personalProviderReceipt(value:unknown,modelId:string):PersonalProviderReceipt {
    if(!object(value)||!exact(value,['modelId','providerId','requestKey','requestHash','connectionRevision','credentialRevision','hasKey','acceptedAt'])||value.modelId!==modelId||!sha(value.providerId)||!uuid(value.requestKey)||!sha(value.requestHash)
        ||!integer(value.connectionRevision,1)||!integer(value.credentialRevision,1)||typeof value.hasKey!=='boolean'||!date(value.acceptedAt))throw Error('Квитанция личного доступа не подтверждена. Прежний ключ повтора сохранён.');
    return value as unknown as PersonalProviderReceipt;
}
