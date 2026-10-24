import type {IBridgeJob} from '../McpBridge/api';
import type {LearningMemoryRequest} from './learningMemorySyncApi';
import type {LearningQuirksJobInput} from './quirksImportTypes';

export type LearningBridgeInput=LearningMemoryRequest|(LearningQuirksJobInput&{requestKey:string});
export type LearningBridgeKind=LearningBridgeInput['kind'];
export interface LearningBridgeIntent{actorRole:string;requestFingerprint:string;input:LearningBridgeInput}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0;
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const unavailable=()=>new Error('Не удалось сохранить исходный запрос в браузере. Новая отправка недоступна. Разрешите хранение данных сайта и проверьте состояние.');
/** Durable ownership survives role or project-name changes; live requests still use the complete auth scope. */
export function learningBridgeActor(scope:string):{principal:string;role:string}{
 try{const value=JSON.parse(scope);if(object(value)&&text(value.id)&&text(value.email)&&text(value.activeRole))return {principal:JSON.stringify([value.id,value.email]),role:value.activeRole};}catch{/* Unknown scopes retain their own isolation. */}
 return {principal:scope,role:scope};
}
export const learningBridgeScope=(scope:string,projectId:string,kind:LearningBridgeKind)=>'neurocenter.learning.bridge.'+JSON.stringify([learningBridgeActor(scope).principal,projectId,kind]);
export const learningBridgeActive=(job:IBridgeJob|undefined)=>!!job&&['queued','running','reconciling'].includes(job.state);

/** Matches DeviceJobs.create's existing digest, including the original actor role and every input field. */
export async function learningBridgeFingerprint(input:LearningBridgeInput,actorRole:string):Promise<string>{
 if(!globalThis.crypto?.subtle)throw new Error('Браузер не может проверить исходный запрос. Откройте Нейроцентр по HTTPS или через localhost и повторите.');
 const raw=JSON.stringify({role:actorRole,request:Object.entries(input).sort(([a],[b])=>a.localeCompare(b))});
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
 return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
}

/** Only original enqueue metadata is retained: no Memory text, quirks or configuration values. */
export function requireLearningBridgeInput(value:unknown,projectId:string,kind:LearningBridgeKind):LearningBridgeInput{
 if(!object(value)||value.projectId!==projectId||value.kind!==kind||!uuid(value.requestKey)||!text(value.deviceId)||!text(value.assetId)
  ||!Number.isSafeInteger(value.version)||Number(value.version)<1||!text(value.expectedManifest)||!text(value.expectedBindingId)||!text(value.expectedInstanceId))throw new Error('Сохранённый исходный запрос повреждён. Новая отправка заблокирована.');
 const common=['kind','deviceId','projectId','requestKey','assetId','assetKind','version','expectedManifest','expectedBindingId','expectedInstanceId'];
 if(kind==='sync-learning-memory'){
  if(value.assetKind!=='mcp'||!['sync','cleanup'].includes(String(value.memoryMode))||!Number.isSafeInteger(value.expectedLearningRevision)||Number(value.expectedLearningRevision)<0||!text(value.expectedLearningDigest)
   ||Object.keys(value).some(key=>![...common,'expectedLearningRevision','expectedLearningDigest','memoryMode'].includes(key)))throw new Error('Сохранённый запрос Memory повреждён.');
 }else if(!['mcp','plugin'].includes(String(value.assetKind))||!Array.isArray(value.expectedConfigurationRevisions)
  ||value.expectedConfigurationRevisions.some(item=>!object(item)||!text(item.assetId)||!text(item.manifest)||item.revision!==null&&!text(item.revision)||Object.keys(item).some(key=>!['assetId','manifest','revision'].includes(key)))
  ||Object.keys(value).some(key=>![...common,'expectedConfigurationRevisions'].includes(key)))throw new Error('Сохранённый запрос сбора повреждён.');
 return value as unknown as LearningBridgeInput;
}
export function readLearningBridgeIntent(key:string,projectId:string,kind:LearningBridgeKind):LearningBridgeIntent|undefined{
 let raw:string|null;try{raw=sessionStorage.getItem(key);}catch{throw unavailable();}
 if(!raw)return;
 let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw new Error('Сохранённый исходный запрос повреждён. Новая отправка заблокирована.');}
 if(!object(parsed)||!text(parsed.actorRole)||typeof parsed.requestFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(parsed.requestFingerprint)||Object.keys(parsed).some(key=>!['actorRole','requestFingerprint','input'].includes(key)))throw new Error('Сохранённый исходный запрос повреждён. Новая отправка заблокирована.');
 return {actorRole:parsed.actorRole,requestFingerprint:parsed.requestFingerprint,input:requireLearningBridgeInput(parsed.input,projectId,kind)};
}
export function saveLearningBridgeIntent(key:string,intent:LearningBridgeIntent):LearningBridgeIntent{
 const {input}=intent,next={...intent,input:requireLearningBridgeInput(JSON.parse(JSON.stringify(input)),input.projectId,input.kind)};
 const previous=readLearningBridgeIntent(key,input.projectId,input.kind);
 if(previous&&JSON.stringify(previous)!==JSON.stringify(next))throw new Error('Сначала проверьте исходный запрос. Новый запрос не отправлен.');
 try{sessionStorage.setItem(key,JSON.stringify(next));}catch{throw unavailable();}
 return next;
}
export function clearLearningBridgeIntent(key:string,intent:LearningBridgeIntent):void{
 const previous=readLearningBridgeIntent(key,intent.input.projectId,intent.input.kind);
 if(previous&&JSON.stringify(previous)!==JSON.stringify(intent))throw new Error('В браузере уже сохранён другой запрос. Обновите состояние.');
 try{sessionStorage.removeItem(key);}catch{throw unavailable();}
}
/** The exact-key lookup is accepted only when every public target pin matches the original request. */
export function requireLearningBridgeReceipt(value:{requestKey:string;requestFingerprint:string|null;job:IBridgeJob},intent:LearningBridgeIntent):IBridgeJob{
 const job=value?.job,input=intent.input;
 if(value?.requestKey!==input.requestKey||value.requestFingerprint!==intent.requestFingerprint||!job||!text(job.id)||!['queued','running','reconciling','succeeded','failed','cancelled'].includes(job.state)
  ||job.projectId!==input.projectId||job.deviceId!==input.deviceId||job.kind!==input.kind||job.assetId!==input.assetId||job.assetKind!==input.assetKind
  ||String(job.version)!==String(input.version)||job.expectedManifest!==input.expectedManifest||job.bindingId!==input.expectedBindingId||job.expectedInstanceId!==input.expectedInstanceId)
  throw new Error('Ответ не подтверждает исходный запрос, проект и установку. Проверьте отправку ещё раз.');
 return job;
}
