import {isAxiosError} from 'axios';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {errorMessage} from '../../common/utils/errorMessage';
import {catalogRequestsApi} from './api';
import {requireRequestPage} from './model';
import type {IRequestFilters,IRequestPage} from './types';

/** Current session and query own each response; older reads cannot replace a newer queue. */
export function useCatalogRequests(filters:IRequestFilters){
    const {captureOwner}=useAuthRequestOwner();
    const [page,setPage]=useState<IRequestPage|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[accessDenied,setAccessDenied]=useState(false);
    const generation=useRef(0),key=JSON.stringify(filters);
    const refresh=useCallback(async()=>{
        const owns=captureOwner(),sequence=++generation.current,current=()=>owns()&&sequence===generation.current;
        if(!owns())return;
        setLoading(true);
        try{const result=requireRequestPage(await catalogRequestsApi.list(JSON.parse(key) as IRequestFilters));if(current()){setPage(result);setError('');setAccessDenied(false);}}
        catch(cause){if(current()){if(isAxiosError(cause)&&[401,403].includes(cause.response?.status??0)){setPage(null);setAccessDenied(true);}setError(errorMessage(cause,'Не удалось загрузить заявки. Повторите попытку.'));}}
        finally{if(current())setLoading(false);}
    },[captureOwner,key]);
    useEffect(()=>{setPage(null);void refresh();return()=>{generation.current++;};},[refresh]);
    useSectionUpdates(['requests'],()=>{void refresh();});
    return {page,loading,error,accessDenied,refresh};
}
