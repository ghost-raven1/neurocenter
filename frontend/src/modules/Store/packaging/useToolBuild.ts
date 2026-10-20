import {useCallback,useEffect,useRef,useState} from 'react';
import {isAxiosError} from 'axios';
import {useLocation} from 'react-router-dom';
import {errorMessage} from '../../../common/utils/errorMessage';
import {packagingApi} from './api';
import type {ToolBuild,ToolBuildRequest} from './types';
import {acceptBuildProgress,readPendingBuild,resumePendingBuild,savePendingBuild} from './pendingBuild';
import {readBuildCheckpoint,saveBuildCheckpoint} from './buildRecovery';
import {clearStoredBuildDraft,readStoredBuildDraft,saveStoredBuildDraft,type StoredBuildDraft} from './buildDraftStore';

const finished=(job:ToolBuild):boolean=>['SUCCEEDED','FAILED'].includes(job.state);

/** Exact request durable до POST; поздние ответы и очистка привязаны к владельцу и UUID. */
export function useToolBuild(scope:string){
    const location=useLocation();
    const [loadedScope,setLoadedScope]=useState(scope),[job,setJob]=useState<ToolBuild>(),[jobId,setJobId]=useState<string>();
    const [pendingKey,setPendingKey]=useState<string>(),[unresolvedKey,setUnresolvedKey]=useState<string>();
    const [submitting,setSubmitting]=useState(false),[recovering,setRecovering]=useState(true),[recoveryBlocked,setRecoveryBlocked]=useState(false);
    const [draft,setDraft]=useState<StoredBuildDraft>(),[error,setError]=useState('');
    const [storageError,setStorageError]=useState(''),[recoveryAttempt,setRecoveryAttempt]=useState(0);
    const owner=useRef(0),renderScope=useRef(scope),busy=useRef(false),jobKnown=useRef(false),saved=useRef<StoredBuildDraft>();
    const storageConflict=():void=>{setRecoveryBlocked(true);setStorageError('Запрос упаковки изменён в другой вкладке. Нажмите «Повторить восстановление запроса», чтобы открыть сохранённый запрос.');};
    if(renderScope.current!==scope){renderScope.current=scope;owner.current++;}
    const apply=useCallback((next:ToolBuild)=>{
        jobKnown.current=true;setError('');setJob(previous=>acceptBuildProgress(previous,next));setJobId(next.id);
        if(saveBuildCheckpoint(scope,'job',next.id))savePendingBuild(scope);
        setPendingKey(undefined);setUnresolvedKey(undefined);
    },[scope]);

    useEffect(()=>{
        const current=++owner.current,savedJob=readBuildCheckpoint(scope,'job');
        busy.current=false;jobKnown.current=!!savedJob;saved.current=undefined;
        setLoadedScope(scope);setJob(undefined);setJobId(savedJob);setPendingKey(undefined);setUnresolvedKey(undefined);
        setDraft(undefined);setError('');setStorageError('');setSubmitting(false);setRecovering(true);setRecoveryBlocked(false);
        void readStoredBuildDraft(scope).then(record=>{
            if(owner.current!==current)return;
            saved.current=record;setDraft(record);
            if(record){jobKnown.current=false;setJobId(undefined);setPendingKey(record.request.requestKey);}
            else setPendingKey(savedJob?undefined:readPendingBuild(scope));
        }).catch(cause=>{
            if(owner.current===current){setRecoveryBlocked(true);setStorageError(errorMessage(cause,'Не удалось восстановить исходный запрос. Новая сборка не отправлена.'));}
        }).finally(()=>{if(owner.current===current)setRecovering(false);});
        return()=>{owner.current++;};
    },[scope,apply,recoveryAttempt]);

    useEffect(()=>{
        if(loadedScope!==scope)return;
        if(jobId)saveBuildCheckpoint(scope,'job',jobId);
        else if(pendingKey||unresolvedKey)saveBuildCheckpoint(scope,'request',pendingKey||unresolvedKey);
    },[location.pathname,location.search,location.hash,loadedScope,scope,jobId,pendingKey,unresolvedKey]);

    useEffect(()=>{
        if(!pendingKey||jobId)return;
        const controller=new AbortController(),current=owner.current;
        void resumePendingBuild(pendingKey,packagingApi.lookup,controller.signal,()=>{
            if(owner.current===current&&!controller.signal.aborted)setError('Проверяем сохранённый запрос. Новую сборку не запускаем.');
        }).then(next=>{if(owner.current===current&&!controller.signal.aborted)apply(next);}).catch(cause=>{
            if(owner.current!==current||controller.signal.aborted)return;
            // Даже определённый отказ lookup не разрешает изменить сохранённое тело POST.
            setUnresolvedKey(pendingKey);setPendingKey(undefined);
            setError(errorMessage(cause,'Не удалось найти запрос сборки. Проверьте операции перед новой попыткой.'));
        });
        return()=>controller.abort();
    },[pendingKey,jobId,apply]);

    useEffect(()=>{
        if(!jobId||job&&finished(job))return;
        let closed=false,timer:ReturnType<typeof setTimeout>;
        const current=owner.current;
        const poll=async()=>{
            try{const next=await packagingApi.get(jobId);if(!closed&&owner.current===current)apply(next);}
            catch(cause){
                if(closed||owner.current!==current)return;
                if(isAxiosError(cause)&&[403,404].includes(cause.response?.status??0)){
                    closed=true;busy.current=false;jobKnown.current=false;setSubmitting(false);setJobId(undefined);setJob(undefined);saveBuildCheckpoint(scope,'job');
                    if(saved.current){setUnresolvedKey(saved.current.request.requestKey);}
                    setError(cause.response?.status===404?'Сборка не найдена. Проверьте сохранённый запрос перед повтором.':'Доступ к сборке изменился. Обновите данные профиля.');
                }else setError(errorMessage(cause,'Не удалось обновить прогресс. Повторяем подключение…'));
            }finally{if(!closed)timer=setTimeout(()=>{void poll();},2000);}
        };
        timer=setTimeout(()=>{void poll();},1000);
        return()=>{closed=true;clearTimeout(timer);};
    },[jobId,job?.state,apply,scope]);

    const send=async(request:ToolBuildRequest,retained=false):Promise<void>=>{
        if(busy.current||recovering||recoveryBlocked||pendingKey||jobId&&(!job||!finished(job)))return;
        const current=owner.current;busy.current=true;setSubmitting(true);setError('');
        try{
            const record=await saveStoredBuildDraft(scope,request);
            if(owner.current!==current)return;
            saved.current=record;setDraft(record);jobKnown.current=false;
            // IndexedDB commit already preserves UUID+body when History/localStorage is unavailable.
            saveBuildCheckpoint(scope,'request',record.request.requestKey);
            setUnresolvedKey(undefined);setPendingKey(record.request.requestKey);
            try{const next=await packagingApi.create(record.request);if(owner.current===current)apply(next);}
            catch(cause){
                if(owner.current!==current||jobKnown.current)return;
                if(isAxiosError(cause)&&[400,401,403,404,409,413,422].includes(cause.response?.status??0)){
                    setPendingKey(undefined);
                    if(retained)setUnresolvedKey(record.request.requestKey);
                    else {
                        try {
                            const cleared=await clearStoredBuildDraft(scope,record.request.requestKey);
                            if(owner.current!==current)return;
                            if(cleared===false){storageConflict();return;}
                            saved.current=undefined;setDraft(undefined);savePendingBuild(scope);setUnresolvedKey(undefined);
                        }catch{if(owner.current===current)setUnresolvedKey(record.request.requestKey);}
                    }
                }
                setError(errorMessage(cause,'Ответ не получен. Проверяем сохранённый запрос сборки.'));
            }
        }catch(cause){
            if(owner.current===current){
                setError(errorMessage(cause,'Не удалось сохранить точный запрос. Сборка не отправлена.'));
                // Another tab may already own this scope. Read its request instead of overwriting it.
                try{const record=await readStoredBuildDraft(scope);if(owner.current===current&&record){saved.current=record;setDraft(record);setPendingKey(record.request.requestKey);}}catch{/* Первый отказ хранения уже показан. */}
            }
        }finally{if(owner.current===current){busy.current=false;setSubmitting(false);}}
    };
    const submit=async(body:Omit<ToolBuildRequest,'requestKey'>):Promise<void>=>{
        if(saved.current||unresolvedKey){setError('Сначала восстановите сохранённый запрос или вернитесь к исходникам завершённой сборки.');return;}
        await send({...body,requestKey:crypto.randomUUID()});
    };
    const retrySaved=async():Promise<void>=>{
        const record=saved.current;
        if(!record||record.request.requestKey!==unresolvedKey){setError('Точный исходный запрос недоступен. Проверьте его состояние в операциях; другая форма не будет отправлена с прежним UUID.');return;}
        await send(record.request,true);
    };
    const recheck=():void=>{if(unresolvedKey){setPendingKey(unresolvedKey);setUnresolvedKey(undefined);setError('');}};
    const reset=async():Promise<boolean>=>{
        if(busy.current||recoveryBlocked||pendingKey||unresolvedKey||jobId&&(!job||!finished(job)))return false;
        const current=owner.current;busy.current=true;setSubmitting(true);
        try{
            const cleared=await clearStoredBuildDraft(scope,saved.current?.request.requestKey);
            if(owner.current!==current)return false;
            if(cleared===false){storageConflict();return false;}
            saved.current=undefined;setDraft(undefined);jobKnown.current=false;setJob(undefined);setJobId(undefined);setError('');saveBuildCheckpoint(scope,'job');savePendingBuild(scope);return true;
        }catch(cause){if(owner.current===current)setError(errorMessage(cause,'Не удалось завершить восстановление запроса.'));return false;}
        finally{if(owner.current===current){busy.current=false;setSubmitting(false);}}
    };
    const currentView=loadedScope===scope;
    return{job:currentView?job:undefined,submitting,error:currentView?storageError||error:'',submit,reset,recheck,retrySaved,
        draft:currentView?draft:undefined,recovering,recoveryBlocked,retryRecovery:()=>setRecoveryAttempt(value=>value+1),unresolved:currentView&&!!unresolvedKey,
        active:!currentView||recovering||!!pendingKey||!!jobId&&(!job||!finished(job))};
}
