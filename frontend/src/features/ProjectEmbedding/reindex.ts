import api from '../../core/api/base';
import type {IRagIndexProfile} from '../../core/api/interfaces';
import {sha} from './model';

export interface IReindexConnectionTarget {deviceId:string;assetId:string;assetKind:'mcp'|'plugin';version:number;expectedManifest:string;expectedBindingId:string;expectedInstanceId:string;}
export interface IProjectReindexPlan {
    id:string;projectId:string;state:'preparing'|'needs_input'|'building'|'ready'|'applied'|'failed'|'cancelling'|'cancelled'|'stale';
    digest:string;approved:boolean;data:{context:{revision:number;generation:string;dataRevision:number};modelId:string;modelPin:string;profile:IRagIndexProfile;
        sourceSnapshot:string|null;rowCount:number;requiredBytes:number;connection?:IReindexConnectionTarget};local?:{jobId:string|null;state:string;message:string;percent:number|null};progress:number;message:string;createdAt:string;
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const generation=(value:unknown):value is string=>typeof value==='string'&&(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)||/^initial-[a-f0-9]{32}$/.test(value));
const natural=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
/** Неполный receipt или ответ другого проекта не становится управляющим UI-состоянием. */
export function requireReindexPlan(value:unknown,project:string):IProjectReindexPlan{
    const plan=value as IProjectReindexPlan,data=plan?.data;
    if(!plan||!uuid(plan.id)||plan.projectId!==project||!['preparing','needs_input','building','ready','applied','failed','cancelling','cancelled','stale'].includes(plan.state)
        ||!sha(plan.digest)||typeof plan.approved!=='boolean'||!natural(plan.progress)||plan.progress>100||typeof plan.message!=='string'||typeof plan.createdAt!=='string'||!Number.isFinite(Date.parse(plan.createdAt))
        ||!data||typeof data.modelId!=='string'||!sha(data.modelPin)||!natural(data.rowCount)||!natural(data.requiredBytes)||data.sourceSnapshot!==null&&!sha(data.sourceSnapshot)
        ||!data.context||!natural(data.context.revision)||!natural(data.context.dataRevision)||!generation(data.context.generation)
        ||data.profile?.provider!=='openai'||data.profile.model!==`neurocenter/${data.modelId}/sha256/${data.modelPin}`||!natural(data.profile.dimension)||data.profile.dimension<1||data.profile.dimension>16000
        ||plan.local&&(!['waiting','pending','queued','running','reconciling','failed','cancelled','succeeded'].includes(plan.local.state)||plan.local.jobId!==null&&!uuid(plan.local.jobId)||typeof plan.local.message!=='string'||plan.local.percent!==null&&(!natural(plan.local.percent)||plan.local.percent>100))){
        throw new Error('Сервер вернул неполный план переиндексации. Обновите сведения.');
    }
    return plan;
}
const path=(project:string)=>`/api/projects/${encodeURIComponent(project)}/embedding/reindex`;
/** Один durable intent используется для подготовки, сборки и переключения поколения. */
export const projectReindexApi={
    latest:(project:string)=>api.get<unknown>(path(project)).then(result=>result.data===null?null:requireReindexPlan(result.data,project)),
    get:(project:string,id:string)=>api.get<unknown>(`${path(project)}/${encodeURIComponent(id)}`).then(result=>requireReindexPlan(result.data,project)),
    create:(project:string,input:{expectedSelectionRevision:number;modelId:string;expectedModelPin:string;requestKey:string;connection?:IReindexConnectionTarget})=>api.post<unknown>(path(project),input).then(result=>requireReindexPlan(result.data,project)),
    start:(project:string,plan:IProjectReindexPlan)=>api.post<unknown>(`${path(project)}/${encodeURIComponent(plan.id)}/start`,{digest:plan.digest}).then(result=>requireReindexPlan(result.data,project)),
    cancel:(project:string,plan:IProjectReindexPlan)=>api.post<unknown>(`${path(project)}/${encodeURIComponent(plan.id)}/cancel`).then(result=>requireReindexPlan(result.data,project)),
    retryLocal:(project:string,plan:IProjectReindexPlan)=>api.post<unknown>(`${path(project)}/${encodeURIComponent(plan.id)}/local-retry`).then(result=>requireReindexPlan(result.data,project)),
    retry:(project:string,plan:IProjectReindexPlan)=>api.post<unknown>(`${path(project)}/${encodeURIComponent(plan.id)}/retry`).then(result=>requireReindexPlan(result.data,project)),
};
export const reindexPending=(plan:IProjectReindexPlan|undefined):boolean=>!!plan&&(['preparing','building','ready','cancelling'].includes(plan.state)||plan.state==='applied'&&!!plan.local&&['pending','queued','running','reconciling'].includes(plan.local.state));
