import type {RootState} from '../../store';
import {isMainAdminRole} from '../UserBlock/roles';
import type {IBundledSourcePlan,ICatalogRebuild} from './types';

export const CATALOG_REBUILD_POLL_MS=5000;
export const CATALOG_REBUILD_POLL_LIMIT=60;

/** The active, currently granted Main role alone may read unpublished source plans. */
export function canReadCatalogSources(state:RootState):boolean{
    const user=state.userBlock.user;
    return !!user&&isMainAdminRole(user.activeRole)&&user.userRoles.includes(user.activeRole);
}

export const catalogRebuildPending=(rebuild:ICatalogRebuild|undefined):boolean=>
    rebuild?.state==='preparing'||!!rebuild?.items.some(item=>item.state==='pending');

/** Source availability never substitutes for an actual published catalog edition. */
export function pendingCatalogSources(plans:readonly IBundledSourcePlan[]=[]):Map<string,IBundledSourcePlan>{
    return new Map(plans.filter(plan=>(plan.kind==='mcp'||plan.kind==='plugin')&&plan.catalogReady===false&&plan.imported
        &&!plan.imported.archived&&!plan.imported.unavailable).map(plan=>[plan.kind+':'+plan.imported!.id,plan]));
}
