import base from '../../core/api/base';
import type {IRetiredRagDatabase,IRetiredRagJob,IRetiredRagPreview} from './types';

const root='/api/maintenance/retired-rag-databases';
/** Cookies и текущая серверная роль проверяются шлюзом и каталогом для каждого действия. */
export const retiredRagApi={
    list:async(signal?:AbortSignal)=>(await base.get<{items:IRetiredRagDatabase[]}>(root,{signal})).data.items,
    preview:async(id:string)=>(await base.post<IRetiredRagPreview>(`${root}/${encodeURIComponent(id)}/preview`,{})).data,
    purge:async(id:string,plan:IRetiredRagPreview,requestKey:string)=>(await base.post<IRetiredRagJob>(`${root}/${encodeURIComponent(id)}/purge`,{requestKey,previewId:plan.id,digest:plan.digest})).data,
    retry:async(job:IRetiredRagJob)=>(await base.post<IRetiredRagJob>(`/api/maintenance/retired-rag-purges/${encodeURIComponent(job.id)}/retry`,{digest:job.digest})).data,
    retention:async(row:IRetiredRagDatabase,retainUntil:string|null,reason:string)=>{await base.patch(`${root}/${encodeURIComponent(row.id)}/retention`,{expectedRevision:row.retention.revision,retainUntil,reason});},
};
