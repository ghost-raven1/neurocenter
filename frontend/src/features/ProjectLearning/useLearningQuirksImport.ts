import {useCallback,useEffect,useRef,useState} from 'react';
import {isAxiosError} from 'axios';
import {errorMessage} from '../../common/utils/errorMessage';
import {bridgeApi,type IBridgeJob} from '../McpBridge/api';
import {createBridgeRequestKey} from '../McpBridge/bridgeRequestKey';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {quirksImportApi} from './quirksImportApi';
import type {LearningQuirksJobInput} from './quirksImportTypes';

/** Role and project changes invalidate every late response while retaining the current user's retry key. */
export function useLearningQuirksImport(projectId:string,reload:()=>Promise<unknown>){
    const {scope,captureOwner}=useAuthRequestOwner(),context=JSON.stringify([scope,projectId]);
    const current=useRef(context);current.current=context;
    const keys=useRef(new Map<string,string>()),lock=useRef(false),generation=useRef(0);
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[submitted,setSubmitted]=useState<IBridgeJob>();
    useEffect(()=>{generation.current++;keys.current.clear();lock.current=false;setBusy(false);setError('');setSubmitted(undefined);return()=>{generation.current++;};},[context]);
    const submit=useCallback(async(input:LearningQuirksJobInput)=>{
        if(lock.current||input.projectId!==projectId)return;
        const owns=captureOwner(),seq=generation.current,active=()=>owns()&&current.current===context&&generation.current===seq;
        if(!active())return;
        lock.current=true;setBusy(true);setError('');
        const fingerprint=JSON.stringify(input),prior=keys.current.get(fingerprint),requestKey=prior??createBridgeRequestKey();keys.current.set(fingerprint,requestKey);
        try{
            const job=await quirksImportApi.create(input,requestKey);
            if(!active())return;
            if(job.projectId!==input.projectId||job.deviceId!==input.deviceId||job.kind!==input.kind)throw new Error('Ответ не подтверждает выбранный проект и компьютер. Обновите историю перед повтором.');
            keys.current.delete(fingerprint);setSubmitted(job);void reload().catch(()=>{if(active())setError('Задание принято, но состояние недоступно. Обновите историю.');});
        }catch(cause){
            if(!active())return;
            if(!prior&&isAxiosError(cause)&&[400,403,409].includes(cause.response?.status??0))keys.current.delete(fingerprint);
            setError(errorMessage(cause,'Не удалось получить подтверждение сбора. Повтор использует тот же запрос.'));
        }finally{if(active()){lock.current=false;setBusy(false);}}
    },[captureOwner,context,projectId,reload]);
    const cancel=async(id:string)=>{
        const owns=captureOwner(),seq=generation.current,active=()=>owns()&&current.current===context&&generation.current===seq;
        if(!active()||lock.current)return;lock.current=true;setBusy(true);setError('');
        try{await bridgeApi.cancel(id);if(active())await reload();}catch(cause){if(active())setError(errorMessage(cause,'Не удалось остановить сбор. Обновите состояние и повторите.'));}
        finally{if(active()){lock.current=false;setBusy(false);}}
    };
    return {submit,cancel,busy,error,submitted};
}
