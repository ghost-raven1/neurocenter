import type {GgufImportAccept,GgufImportIntent,GgufImportReceipt} from '../../../../services/shared/gguf-import';
import type {GgufImportPolicy} from '../../../../services/shared/gguf-import-policy.cjs';
import type {ICatalogModel} from '../ModelCatalog/types';

export type {GgufImportAccept,GgufImportIntent,GgufImportReceipt,GgufImportPolicy};
export const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
const policyKeys:(keyof GgufImportPolicy)[]=['maximumBytes','storageQuotaBytes','maximumPendingImports','metadataBytes','metadataPairs','tensorCount','arrayElements','stringBytes','activeUploads','uploadTimeoutMs','checkIntervalMs','retentionMs','diskReserveBytes','runtimeRequestTimeoutMs','runtimeResponseBytes'];

/** Display only limits supplied by the server; product size defaults stay on the server. */
export function readPolicy(value:unknown):Readonly<GgufImportPolicy>{
    if(!object(value)||policyKeys.some(key=>!positive(value[key])))throw Error('Сервер не подтвердил лимиты импорта. Повторите проверку.');
    return {...value} as unknown as GgufImportPolicy;
}
export function validateFile(file:File,maximumBytes:number):void{
    if(!file.name.toLowerCase().endsWith('.gguf')||file.name.startsWith('.')||/[\\/\x00-\x1f\x7f]/.test(file.name)||new TextEncoder().encode(file.name).length>240)throw Error('Выберите один файл .gguf с именем до 240 байт без служебных символов.');
    if(!positive(file.size)||file.size>maximumBytes)throw Error('Размер файла превышает действующий лимит или файл пуст.');
}
export function readReceipt(value:unknown,key:string,previous?:GgufImportReceipt):GgufImportReceipt{
    if(!object(value)||!uuid(value.id)||value.requestKey!==key||typeof value.fileName!=='string'||!positive(value.bytes)
        ||!['WAITING','UPLOADING','READY','CANCELLED','ACCEPTED'].includes(String(value.state))
        ||typeof value.expiresAt!=='string'||!Number.isFinite(Date.parse(value.expiresAt))
        ||value.expectedSha256!==undefined&&!sha(value.expectedSha256)||value.sha256!==null&&!sha(value.sha256))throw Error('Квитанция импорта не подтверждена. Номер запроса сохранён.');
    const policy=readPolicy(value.limits);validateFile({name:value.fileName,size:value.bytes} as File,policy.maximumBytes);
    if(previous&&((previous.state==='ACCEPTED'||previous.state==='CANCELLED')&&value.state!==previous.state
        ||previous.state==='READY'&&!['READY','ACCEPTED','CANCELLED'].includes(String(value.state))))throw Error('Состояние импорта вернулось к прежнему этапу. Квитанция не подтверждена.');
    if(previous&&(previous.id!==value.id||previous.fileName!==value.fileName||previous.bytes!==value.bytes||previous.expectedSha256!==value.expectedSha256))throw Error('Квитанция относится к другому файлу. Номер запроса сохранён.');
    if(previous&&(policyKeys.some(key=>previous.limits[key]!==policy[key])||previous.sha256&&['READY','ACCEPTED'].includes(String(value.state))&&previous.sha256!==value.sha256))throw Error('Квитанция изменила проверенный файл или правила принятой загрузки. Проверьте состояние.');
    if(['READY','ACCEPTED'].includes(String(value.state))&&(!sha(value.sha256)||!object(value.metadata)||value.metadata.format!=='gguf'
        ||![2,3].includes(Number(value.metadata.version))||typeof value.metadata.architecture!=='string'||!value.metadata.architecture
        ||!positive(value.metadata.tensorCount)||!positive(value.metadata.metadataCount)))throw Error('Проверка GGUF не подтверждена квитанцией.');
    if(value.state==='ACCEPTED'&&value.modelId!=='model-gguf-'+value.id||value.state!=='ACCEPTED'&&value.modelId!==null)throw Error('Модель не подтверждена квитанцией импорта.');
    return {...value,limits:policy} as unknown as GgufImportReceipt;
}
export function readImportedModel(value:unknown,receipt:GgufImportReceipt):ICatalogModel{
    if(!object(value)||value.id!=='model-gguf-'+receipt.id||value.runtime!=='ollama'||value.source!=='custom'
        ||!['chat','embedding'].includes(String(value.capability))||typeof value.name!=='string'||!value.name.trim()||!positive(value.revision)
        ||!object(value.fileImport)||value.fileImport.format!=='gguf'||value.fileImport.uploadId!==receipt.id
        ||value.fileImport.sha256!==receipt.sha256||value.fileImport.bytes!==receipt.bytes||value.fileImport.fileName!==receipt.fileName
        ||value.fileImport.architecture!==receipt.metadata?.architecture||value.fileImport.version!==receipt.metadata?.version)throw Error('Карточка модели не подтверждает этот импорт. Проверьте состояние загрузки.');
    return value as unknown as ICatalogModel;
}
export function acceptance(name:string,description:string,capability:'chat'|'embedding'):GgufImportAccept{
    if(!name.trim()||name.trim().length>128||/[\x00-\x1f\x7f]/.test(name))throw Error('Введите название: от 1 до 128 символов.');
    if(description.length>4000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description))throw Error('Описание: до 4000 символов без служебных знаков.');
    return {name:name.trim(),description:description.trim(),capability};
}
export function formatBytes(bytes:number):string{
    const units=['Б','КиБ','МиБ','ГиБ','ТиБ'];let index=0,value=bytes;
    while(value>=1024&&index<units.length-1){value/=1024;index++;}
    return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(value)+' '+units[index];
}
