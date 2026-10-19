import {useCallback,useEffect,useRef,useState} from 'react';
import bffApi from '../../../../core/api/bff';
import type {IRagQuota} from '../../../../core/api/interfaces';
import {errorMessage} from '../../../../common/utils/errorMessage';
import {useSectionUpdates} from '../../../../core/socket/useSectionUpdates';
import {requireRagQuota} from './model';
import {projectReadUnavailable} from '../../projectReadError';

/** Поздний ответ старого запроса не меняет сведения другого проекта. */
export function useRagQuota(projectKey:string){
    const [quota,setQuota]=useState<IRagQuota|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const generation=useRef(0);
    const accept=useCallback((value:IRagQuota)=>{const valid=requireRagQuota(value);generation.current++;setQuota(valid);setError('');setLoading(false);},[]);
    const refresh=useCallback(async()=>{
        const request=++generation.current;setLoading(true);
        try{const value=requireRagQuota(await bffApi.getRagQuota(projectKey));if(request===generation.current){setQuota(value);setError('');return value;}}
        catch(failure){if(request===generation.current){if(projectReadUnavailable(failure)){setQuota(null);}setError(errorMessage(failure,'Не удалось получить лимит базы знаний.'));}}
        finally{if(request===generation.current){setLoading(false);}}
        return undefined;
    },[projectKey]);
    useEffect(()=>{setQuota(null);setError('');void refresh();return()=>{generation.current++;};},[refresh]);
    const sectionRefresh=useCallback(()=>{void refresh();},[refresh]);useSectionUpdates(['knowledge','projects'],sectionRefresh);
    return {quota,loading,error,refresh,accept};
}
