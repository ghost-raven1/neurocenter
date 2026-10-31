import {useEffect} from 'react';
import {useHistory,useLocation} from 'react-router-dom';

/** Selects through the scoped queue owner; opening a link never retries or cancels work. */
export function useOperationDeepLink(select:(id:string)=>Promise<void>,enabled:boolean):{error:string;clear:()=>void} {
    const location=useLocation(),history=useHistory();
    const requested=enabled?new URLSearchParams(location.search).get('operation'):null;
    const valid=!!requested&&/^[a-z0-9][a-z0-9:_-]{0,159}$/i.test(requested);
    useEffect(()=>{if(valid&&requested)void select(requested);},[select,requested,valid]);
    return {error:requested&&!valid?'Ссылка на операцию некорректна. Выберите операцию из списка.':'',clear:()=>{
        if(!requested)return;const search=new URLSearchParams(location.search);search.delete('operation');
        history.replace(location.pathname+(search.size?'?'+search:'')+location.hash);
    }};
}
