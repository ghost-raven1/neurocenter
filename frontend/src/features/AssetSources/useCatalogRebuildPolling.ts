import {useEffect,useRef} from 'react';
import type {ICatalogRebuild} from './types';
import {CATALOG_REBUILD_POLL_LIMIT,CATALOG_REBUILD_POLL_MS,catalogRebuildPending} from './catalogSourceStatus';

/** Poll only an active rebuild, with one bounded budget per owner/request and no mutation. */
export function useCatalogRebuildPolling(rebuild:ICatalogRebuild|undefined,scope:string,refresh:()=>Promise<void>,enabled=true):void{
    const budget=useRef({key:'',count:0});
    useEffect(()=>{
        const key=JSON.stringify([scope,rebuild?.requestId]);
        if(budget.current.key!==key)budget.current={key,count:0};
        if(!enabled||!catalogRebuildPending(rebuild)||budget.current.count>=CATALOG_REBUILD_POLL_LIMIT)return;
        let active=true,timer:ReturnType<typeof setTimeout>;
        const poll=async():Promise<void>=>{
            budget.current.count++;await refresh();
            if(active&&budget.current.key===key&&budget.current.count<CATALOG_REBUILD_POLL_LIMIT)timer=setTimeout(()=>void poll(),CATALOG_REBUILD_POLL_MS);
        };
        timer=setTimeout(()=>void poll(),CATALOG_REBUILD_POLL_MS);
        return()=>{active=false;clearTimeout(timer);};
    },[enabled,rebuild,scope,refresh]);
}
