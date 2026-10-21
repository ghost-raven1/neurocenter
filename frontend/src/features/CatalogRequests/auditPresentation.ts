import type {IAuditEvent} from '../../core/api/interfaces';
import {requestStates} from './presentation';
import type {IRequestStatus} from './types';

const actions:Record<string,{label:string;color:string}>={
    create:{label:'Заявка подана',color:'blue'},edit:{label:'Заявка изменена',color:'cyan'},start:{label:'Заявка взята в работу',color:'processing'},
    needs_info:{label:'Запрошено уточнение',color:'orange'},reject:{label:'Заявка отклонена',color:'red'},complete:{label:'Заявка выполнена',color:'green'},
    resubmit:{label:'Заявка отправлена повторно',color:'blue'},cancel:{label:'Заявка отменена',color:'default'},
};
export function requestAuditAction(action:string):{label:string;color:string}|undefined {
    const verb=action.startsWith('catalog_request.')?action.slice('catalog_request.'.length):'';
    return Object.prototype.hasOwnProperty.call(actions,verb)?actions[verb]:undefined;
}
const snapshot=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const title=(value:unknown):string|undefined=>typeof snapshot(value).title==='string'?snapshot(value).title as string:undefined;
export function requestAuditTitle(event:IAuditEvent):string|undefined {
    return requestAuditAction(event.action)?title(event.details?.after)||title(event.details?.before):undefined;
}
/** Show only the saved title and status; private request payloads never enter audit presentation. */
export function requestAuditChanges(event:IAuditEvent):Array<{label:string;before:string;after:string}> {
    if(!requestAuditAction(event.action))return [];
    const before=snapshot(event.details?.before),after=snapshot(event.details?.after),changes=[];
    const status=(value:unknown):string=>typeof value==='string'?requestStates[value as IRequestStatus]?.label??'Неизвестный статус':'Не сохранено';
    if(before.status!==after.status)changes.push({label:'Статус заявки',before:status(before.status),after:status(after.status)});
    if(typeof before.title==='string'&&typeof after.title==='string'&&before.title!==after.title)changes.push({label:'Заголовок',before:before.title,after:after.title});
    return changes;
}
export function requestAuditSummary(event:IAuditEvent):string|undefined {
    if(!requestAuditAction(event.action))return;
    return requestAuditChanges(event).map(change=>`${change.label}: ${change.after}`).join(' · ')||'Обновлены данные заявки.';
}
