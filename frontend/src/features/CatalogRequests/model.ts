import type {ICatalogRequest,IRequestDetail,IRequestPage,IRequestTarget,IRequestCreate,IRequestEdit,IRequestMutation,IRequestAction} from './types';
import {requestSourceUrl} from './presentation';

const statuses=['submitted','in_progress','needs_info','completed','rejected','cancelled'];
export function requireRequest(value:ICatalogRequest):ICatalogRequest {
    if(!value||typeof value.id!=='string'||!value.id||!statuses.includes(value.status)||!Number.isInteger(value.revision)||!value.permissions||(['canEdit','canCancel','canReview','canResubmit'] as const).some(key=>typeof value.permissions[key]!=='boolean'))throw new Error('Сервер вернул неполную заявку. Обновите данные.');
    return value;
}
export function requireRequestDetail(value:IRequestDetail):IRequestDetail {
    requireRequest(value);if(!Array.isArray(value.history))throw new Error('История заявки не загружена. Обновите данные.');return value;
}
export function requireRequestPage(value:IRequestPage):IRequestPage {
    if(!value||!Array.isArray(value.items)||!Number.isInteger(value.total)||value.total<0)throw new Error('Сервер вернул неполный список заявок. Повторите загрузку.');
    value.items.forEach(requireRequest);return value;
}
export function requireTargets(value:{items:IRequestTarget[]}):IRequestTarget[]{
    if(!value||!Array.isArray(value.items)||value.items.some(item=>!item||typeof item.id!=='string'||typeof item.name!=='string'||!['plugin','mcp','skill','model'].includes(item.type)||typeof item.version!=='number'||!Number.isInteger(item.version)||!(typeof item.available==='boolean'||item.available===null)))throw new Error('Не удалось проверить список карточек. Повторите загрузку.');
    return value.items;
}
/** The form only normalizes references; fetching, packaging and installing remain separate actions. */
export function requestPayload(value:IRequestCreate):IRequestCreate {
    if(!['add','update','issue'].includes(value.kind)||!['plugin','mcp','skill','model'].includes(value.assetType))throw new Error('Выберите тип обращения и инструмента.');
    if(typeof value.title!=='string'||typeof value.description!=='string')throw new Error('Заполните название и описание.');
    const title=value.title.trim(),description=value.description.trim();
    if(!title||title.length>128)throw new Error('Укажите название до 128 символов.');
    if(!description||description.length>4000)throw new Error('Опишите задачу: от 1 до 4000 символов.');
    if(value.kind!=='add'&&(!value.target||value.target.type!==value.assetType||typeof value.target.id!=='string'||!value.target.id.trim()))throw new Error('Выберите карточку нужного типа.');
    return {kind:value.kind,assetType:value.assetType,title,description,projectId:value.projectId||null,sourceUrl:requestSourceUrl(value.sourceUrl),...(value.kind!=='add'&&value.target?{target:value.target}:{})};
}
export function requestEditPayload(value:IRequestCreate):IRequestEdit {
    const payload=requestPayload(value);return {title:payload.title,description:payload.description,sourceUrl:payload.sourceUrl,...(payload.target?{target:payload.target}:{})};
}
export const requestActive=(value:ICatalogRequest):boolean=>['submitted','in_progress','needs_info'].includes(value.status);

/** Review reasons and completion references are validated before an intent is sent. */
export function requestActionPayload(request:ICatalogRequest,action:IRequestAction,values:{comment?:string;targetId?:string}):IRequestMutation {
    const comment=values.comment?.trim();
    if(['needs_info','reject','complete'].includes(action)&&(!comment||comment.length>4000))throw new Error('Опишите результат или причину: до 4000 символов.');
    if(action==='complete'&&request.kind!=='issue'&&!values.targetId?.trim())throw new Error('Выберите проверенную карточку результата.');
    return {action,...(comment?{comment}:{}),...(action==='complete'&&values.targetId?{target:{type:request.assetType,id:values.targetId}}:{})};
}
