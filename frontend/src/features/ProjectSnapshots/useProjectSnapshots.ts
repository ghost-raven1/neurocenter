import {useCallback,useEffect,useRef,useState} from 'react';
import bffApi from '../../core/api/bff';
import type {IProjectDetail} from '../../core/api/interfaces';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {projectSnapshotsApi} from './api';
import {snapshotPending,type ProjectSnapshot,type SnapshotCapabilities,type SnapshotProfile} from './types';
interface Data {project:IProjectDetail;snapshots:ProjectSnapshot[];profiles:SnapshotProfile[];capabilities:SnapshotCapabilities}
/** List/head/profile reads share an owner fence; server CAS remains the final concurrency authority. */
export function useProjectSnapshots(projectId:string){
    const {scope,captureOwner}=useAuthRequestOwner(),key=JSON.stringify([scope,projectId]);
    const [state,setState]=useState<{key:string;data?:Data;loading:boolean;ready:boolean;error:string}>({key,loading:true,ready:false,error:''});
    const sequence=useRef(0),context=useRef(key),controller=useRef<AbortController>(),reading=useRef(false);context.current=key;
    const refresh=useCallback(async()=>{
        const owns=captureOwner();if(context.current!==key||!owns())return;
        const ticket=++sequence.current,current=()=>context.current===key&&owns()&&ticket===sequence.current;reading.current=true;
        controller.current?.abort();controller.current=new AbortController();const signal=controller.current.signal;
        setState(previous=>({key,data:previous.key===key?previous.data:undefined,loading:true,ready:false,error:''}));
        try{
            const [project,snapshots,profiles,capabilities]=await Promise.all([bffApi.getProject(projectId),projectSnapshotsApi.list(projectId,signal),projectSnapshotsApi.profiles(projectId,signal),projectSnapshotsApi.capabilities(projectId,signal)]);
            if(project.id!==projectId)throw new Error('Ответ относится к другому проекту.');
            if(current())setState({key,data:{project,snapshots,profiles,capabilities},loading:false,ready:true,error:''});
        }catch(cause){if(current())setState(previous=>{
            const status=(cause as {response?:{status?:number}})?.response?.status;
            return {...previous,key,...([401,403,404].includes(status??0)?{data:undefined}:{}),loading:false,ready:false,error:errorMessage(cause,'Не удалось обновить снимки. Действия доступны после успешного чтения.')};
        });}finally{if(ticket===sequence.current)reading.current=false;}
    },[projectId,key,captureOwner]);
    useEffect(()=>{void refresh();return()=>{sequence.current++;controller.current?.abort();};},[refresh]);
    const visible=state.key===key?state:{key,loading:true,ready:false,error:'',data:undefined};
    const pending=visible.data?.snapshots.some(snapshotPending)??false;
    useEffect(()=>{if(!pending)return;const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!reading.current)void refresh();},2500);return()=>clearInterval(timer);},[pending,refresh]);
    return {...visible,refresh};
}
