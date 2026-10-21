import {BadRequestException} from '@nestjs/common';
import type {ActionRequest,AssetType,CreateRequest,EditRequest,RequestFields,RequestFilter,RequestKind,RequestStatus,TargetInput} from './request.types';
const kinds=['add','update','issue'] as const;
const assets=['plugin','mcp','skill','model'] as const;
const statuses=['submitted','in_progress','needs_info','rejected','completed','cancelled'] as const;
const actions=['start','needs_info','reject','complete','resubmit','cancel'] as const;
export function object(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new BadRequestException('Передайте поддерживаемые поля заявки.');
 return value as Record<string,unknown>;
}
function text(value:unknown,name:string,max:number,optional=false):string{
 if(optional&&(value===undefined||value===null))return '';
 if(typeof value!=='string'||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)||!optional&&!value.trim())throw new BadRequestException('Проверьте поле «'+name+'» (до '+max+' символов).');
 return value.trim();
}
function choice<T extends string>(value:unknown,values:readonly T[],name:string):T{
 if(typeof value!=='string'||!values.includes(value as T))throw new BadRequestException('Некорректное поле «'+name+'».');return value as T;
}
export function uuid(value:unknown):string{
 if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))throw new BadRequestException('Нужен UUID заявки или запроса.');return value.toLowerCase();
}
function revision(value:unknown):number{if(!Number.isSafeInteger(value)||Number(value)<1)throw new BadRequestException('Укажите текущую ревизию заявки.');return Number(value);}
export function projectId(value:unknown):string|null{
 if(value===undefined||value===null||value==='')return null;
 const id=text(value,'Проект',256);if(!/^prj-[A-Za-z0-9-]+$/.test(id))throw new BadRequestException('Выберите проект по его ID.');return id;
}
export function assetType(value:unknown):AssetType{return choice(value,assets,'Тип инструмента');}
export function target(value:unknown):TargetInput|null{
 if(value===undefined||value===null)return null;
 const input=object(value,['type','id']),type=assetType(input.type),id=text(input.id,'Карточка',240);
 if(/[\r\n]/.test(id)||type==='skill'&&(!/^(?:common|project-[a-z0-9_-]+)\//.test(id)||id.split('/').some(segment=>!/^[a-z0-9][a-z0-9_-]*$/.test(segment)))||id.includes('..')||id.includes('//'))throw new BadRequestException('Выберите существующую карточку каталога.');
 return {type,id};
}
function sourceUrl(value:unknown):string|null{
 if(value===undefined||value===null||value==='')return null;
 const input=text(value,'Ссылка',2048);let url:URL;try{url=new URL(input);}catch{throw new BadRequestException('Укажите полную HTTP(S)-ссылку.');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||/[\r\n]/.test(input))throw new BadRequestException('Ссылка должна использовать HTTP(S) без логина и пароля.');
 return url.href;
}
function fields(input:Record<string,unknown>):RequestFields{return {title:text(input.title,'Заголовок',160),description:text(input.description,'Описание',10000),sourceUrl:sourceUrl(input.sourceUrl),target:target(input.target)};}
export function createInput(raw:unknown):CreateRequest{
 const input=object(raw,['requestKey','kind','assetType','title','description','sourceUrl','projectId','target']);
 const result={...fields(input),requestKey:uuid(input.requestKey),kind:choice<RequestKind>(input.kind,kinds,'Вид заявки'),assetType:assetType(input.assetType),projectId:projectId(input.projectId)};
 if(result.kind==='add'&&result.target||result.kind!=='add'&&!result.target||result.target&&result.target.type!==result.assetType)throw new BadRequestException('Обновление и проблема требуют карточку выбранного типа; добавление создаётся без карточки.');return result;
}
export function editInput(raw:unknown):EditRequest{const input=object(raw,['requestKey','expectedRevision','title','description','sourceUrl','target']);return {...fields(input),requestKey:uuid(input.requestKey),expectedRevision:revision(input.expectedRevision)};}
export function actionInput(raw:unknown):ActionRequest{
 const input=object(raw,['requestKey','expectedRevision','action','comment','target']),action=choice(input.action,actions,'Действие');
 const comment=text(input.comment,'Комментарий',4000,!['needs_info','reject','complete'].includes(action));
 if(input.target!==undefined&&action!=='complete')throw new BadRequestException('Карточка результата передаётся только при завершении.');
 return {requestKey:uuid(input.requestKey),expectedRevision:revision(input.expectedRevision),action,comment,target:target(input.target)};
}
function positive(value:unknown,fallback:number,max:number):number{
 if(value===undefined)return fallback;if(typeof value!=='string'||!/^\d+$/.test(value)||Number(value)<1||!Number.isSafeInteger(Number(value))||Number(value)>max)throw new BadRequestException('Некорректная страница или размер списка.');return Number(value);
}
export function listInput(raw:unknown):RequestFilter{
 const input=object(raw,['scope','status','kind','assetType','projectId','page','size']);
 return {scope:input.scope===undefined?'mine':choice(input.scope,['mine','all'],'Список'),page:positive(input.page,1,1000000),size:positive(input.size,20,100),
 ...(input.status!==undefined?{status:choice<RequestStatus>(input.status,statuses,'Статус')}:{}),...(input.kind!==undefined?{kind:choice<RequestKind>(input.kind,kinds,'Вид заявки')}:{}),
 ...(input.assetType!==undefined?{assetType:assetType(input.assetType)}:{}),...(input.projectId!==undefined?{projectId:projectId(input.projectId)??undefined}:{})};
}
export function targetQuery(raw:unknown){const input=object(raw,['assetType','projectId','q','limit']);return {assetType:assetType(input.assetType),projectId:projectId(input.projectId),q:text(input.q,'Поиск',120,true),limit:positive(input.limit,50,100)};}
