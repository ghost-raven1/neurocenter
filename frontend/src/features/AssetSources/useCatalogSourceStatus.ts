import {useCallback,useEffect,useRef,useState} from 'react';
import {useSelector} from 'react-redux';
import {baseApi} from '../../core/api';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {canReadCatalogSources} from './catalogSourceStatus';
import {useCatalogRebuildPolling} from './useCatalogRebuildPolling';
import type {ISourceList} from './types';

interface IState {key:string;data?:ISourceList;error:string}

/** Read-only Main metadata is masked synchronously when the project, session or active rights change. */
export function useCatalogSourceStatus(context:string,enabled=true){
    const isMain=useSelector(canReadCatalogSources),{scope,captureOwner}=useAuthRequestOwner();
    const key=JSON.stringify([scope,context,isMain,enabled]),latest=useRef(key);latest.current=key;
    const [state,setState]=useState<IState>(),request=useRef(0),inFlight=useRef<{key:string;controller:AbortController}>();
    const refresh=useCallback(async():Promise<void>=>{
        const owns=captureOwner();if(!isMain||!enabled||latest.current!==key||!owns()||inFlight.current?.key===key)return;
        inFlight.current?.controller.abort();const controller=new AbortController(),flight={key,controller};inFlight.current=flight;
        const number=++request.current,current=()=>owns()&&latest.current===key&&request.current===number;
        try{
            const response=await baseApi.get<ISourceList>('/api/asset-sources',{signal:controller.signal,timeout:10000});
            if(current())setState({key,data:response.data,error:''});
        }catch(cause){
            if(current()&&!controller.signal.aborted){
                const status=(cause as {response?:{status?:number}})?.response?.status;
                setState(previous=>({key,data:status===401||status===403?undefined:previous?.key===key?previous.data:undefined,
                    error:status===401||status===403?'Доступ к исходникам не подтверждён.':'Не удалось обновить сведения об исходниках. Показан последний прочитанный результат.'}));
            }
        }finally{if(inFlight.current===flight)inFlight.current=undefined;}
    },[captureOwner,isMain,enabled,key]);
    useEffect(()=>{void refresh();return()=>{request.current++;if(inFlight.current?.key===key){inFlight.current.controller.abort();inFlight.current=undefined;}};},[key,refresh]);
    const current=isMain&&enabled&&state?.key===key?state:undefined;
    useCatalogRebuildPolling(current?.data?.rebuild,key,refresh,isMain&&enabled);
    return {data:current?.data,error:current?.error??'',refresh};
}
