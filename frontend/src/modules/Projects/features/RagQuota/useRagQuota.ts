import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import bffApi from '../../../../core/api/bff';
import type {IRagQuota} from '../../../../core/api/interfaces';
import {errorMessage} from '../../../../common/utils/errorMessage';
import {useSectionUpdates} from '../../../../core/socket/useSectionUpdates';
import {requireRagQuota} from './model';
import {projectReadUnavailable} from '../../projectReadError';
import {useAuthRequestOwner} from '../../../../features/UserBlock/useAuthRequestOwner';

/** Ответы и callbacks принадлежат проекту, роли и открытому экземпляру вкладки. */
export function useRagQuota(projectKey:string){
    const {captureOwner}=useAuthRequestOwner();
    const view=useMemo(()=>({active:false}),[projectKey,captureOwner]);
    const latestView=useRef(view);latestView.current=view;
    const [loadedView,setLoadedView]=useState(view);
    const [quota,setQuota]=useState<IRagQuota|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const generation=useRef(0);
    const captureCurrent=useCallback(()=>{const owns=captureOwner();return()=>owns()&&view.active&&latestView.current===view;},[captureOwner,view]);
    const accept=useCallback((value:IRagQuota)=>{if(!captureCurrent()()){return;}const valid=requireRagQuota(value);generation.current++;setQuota(valid);setError('');setLoading(false);},[captureCurrent]);
    const refresh=useCallback(async()=>{
        const owns=captureCurrent();if(!owns()){return undefined;}
        const request=++generation.current;setLoading(true);
        const current=()=>owns()&&request===generation.current;
        try{const value=requireRagQuota(await bffApi.getRagQuota(projectKey));if(current()){setQuota(value);setError('');return value;}}
        catch(failure){if(current()){if(projectReadUnavailable(failure)){setQuota(null);}setError(errorMessage(failure,'Не удалось получить лимит базы знаний.'));}}
        finally{if(current()){setLoading(false);}}
        return undefined;
    },[projectKey,captureCurrent]);
    useEffect(()=>{view.active=true;setLoadedView(view);setQuota(null);setError('');void refresh();return()=>{view.active=false;generation.current++;};},[refresh,view]);
    const sectionRefresh=useCallback(()=>{void refresh();},[refresh]);useSectionUpdates(['knowledge','projects'],sectionRefresh);
    const current=loadedView===view;
    return {quota:current?quota:null,loading:!current||loading,error:current?error:'',refresh,accept,captureCurrent};
}
