import type {IRetiredRagDatabase} from './types';

export type TRetiredRagFilter = 'all'|'retained'|'deleted';

/** A missing database needs a deletion receipt before the UI may call it deleted. */
export function retiredRagStatus(row:IRetiredRagDatabase){
    const pending=!!row.job&&['queued','running'].includes(row.job.state);
    const anomaly=row.database?.state==='purged'&&row.database.present;
    const purged=!row.database?.present&&(row.database?.state==='purged'||row.job?.state==='succeeded');
    const missing=!!row.database&&!row.database.present&&!purged;
    return {pending,anomaly,purged,missing,
        label:anomaly?'Требует проверки':purged?'Удалена':missing?'База отсутствует':pending?'Удаление проверяется':'Сохранена',
        color:anomaly||missing?'warning':purged?'default':pending?'processing':'blue'};
}

/** Filters and bounded pages change only the visible inventory; source records stay intact. */
export function retiredRagPage(items:IRetiredRagDatabase[],query:string,filter:TRetiredRagFilter,page:number){
    const pageSize=5;
    const search=query.trim().toLocaleLowerCase('ru-RU');
    const filtered=items.filter(row=>(filter==='all'||retiredRagStatus(row).purged===(filter==='deleted'))
        &&(!search||`${row.projectName} ${row.projectId} ${row.database?.databaseName??''}`.toLocaleLowerCase('ru-RU').includes(search)));
    const current=Math.max(1,Math.min(Number.isSafeInteger(page)?page:1,Math.ceil(filtered.length/pageSize)));
    return {items:filtered.slice((current-1)*pageSize,current*pageSize),total:filtered.length,page:current,pageSize};
}
