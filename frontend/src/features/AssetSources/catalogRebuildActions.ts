import type {IBundledSourcePlan,ICatalogRebuildItem} from './types';

export interface CatalogRebuildAction {kind:'operation'|'prepare'|'archive';label:string;href:string}

/** Recovery opens the accepted operation before offering a separate preparation request. */
export function catalogRebuildAction(item:ICatalogRebuildItem,plans:readonly IBundledSourcePlan[]=[]):CatalogRebuildAction|undefined {
    if(item.state==='ready')return;
    if(item.operationId&&!item.id.startsWith('inline:')){
        // Earlier rebuild receipts stored the build UUID rather than its operations identifier.
        const operation=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.operationId)?'tool-build-'+item.operationId:item.operationId;
        return {kind:'operation',label:'Открыть операцию',href:'/operations?'+new URLSearchParams({operation})};
    }
    if(item.state==='archive-required')return {kind:'archive',label:'Импортировать архив',href:'/assets?archive=open'};
    const plan=plans.find(value=>value.id===item.id);
    if(item.state==='attention'&&plan&&!plan.catalogReady&&!plan.imported?.archived&&!plan.imported?.unavailable
        &&['mcp','plugin'].includes(plan.kind)&&['prepared','local-project'].includes(plan.delivery)){
        return {kind:'prepare',label:plan.imported?'Подготовить обновление':'Подготовить пакет',href:'/assets?'+new URLSearchParams({prepare:plan.id})};
    }
}
