import {useCallback,useEffect,useRef,useState} from 'react';
import {isAxiosError} from 'axios';
import {useLocation} from 'react-router-dom';
import {errorMessage} from '../../../common/utils/errorMessage';
import {packagingApi} from './api';
import type {ToolBuild,ToolBuildRequest} from './types';
import {acceptBuildProgress,readPendingBuild,resumePendingBuild,savePendingBuild} from './pendingBuild';
import {readBuildCheckpoint,saveBuildCheckpoint} from './buildRecovery';
import {archiveStoredBuildCancellation,clearStoredBuildCancellation,clearStoredBuildDraft,listStoredBuildArchives,readStoredBuildRecovery,restoreStoredBuildArchive,saveStoredBuildCancellation,saveStoredBuildDraft,type ArchivedBuildSummary,type BuildCancellationAcknowledgment,type StoredBuildCancellation,type StoredBuildDraft} from './buildDraftStore';

const finished=(job:ToolBuild):boolean=>['SUCCEEDED','FAILED','CANCELLED'].includes(job.state);

/** Exact request durable до POST; поздние ответы и очистка привязаны к владельцу и UUID. */
export function useToolBuild(scope:string){
    const location=useLocation();
    const [loadedScope,setLoadedScope]=useState(scope),[job,setJob]=useState<ToolBuild>(),[jobId,setJobId]=useState<string>();
    const [pendingKey,setPendingKey]=useState<string>(),[unresolvedKey,setUnresolvedKey]=useState<string>();
    const [submitting,setSubmitting]=useState(false),[recovering,setRecovering]=useState(true),[recoveryBlocked,setRecoveryBlocked]=useState(false);
    const [draft,setDraft]=useState<StoredBuildDraft>(),[error,setError]=useState('');
    const [storageError,setStorageError]=useState(''),[recoveryAttempt,setRecoveryAttempt]=useState(0);
    const [cancelIntent,setCancelIntent]=useState<StoredBuildCancellation>(),[cancelling,setCancelling]=useState(false),[cancelled,setCancelled]=useState(false);
    const [cancelAck,setCancelAck]=useState<BuildCancellationAcknowledgment>(),[archived,setArchived]=useState<ArchivedBuildSummary[]>([]),[archiveError,setArchiveError]=useState(''),[archiveRevision,setArchiveRevision]=useState(0),[archiving,setArchiving]=useState(false);
    const owner=useRef(0),renderScope=useRef({scope,attempt:recoveryAttempt}),busy=useRef(false),jobKnown=useRef(false),saved=useRef<StoredBuildDraft>(),observation=useRef(0);
    const cancellation=useRef<StoredBuildCancellation>(),cancelWanted=useRef(false),cancelBusy=useRef(false),saveInFlight=useRef<Promise<StoredBuildDraft>>(),submission=useRef(0);
    const replayedCancellation=useRef<StoredBuildCancellation>();
    const cancelRequest=useRef<AbortController>();
    const archiveBusy=useRef(false);
    const storageConflict=():void=>{setRecoveryBlocked(true);setStorageError('Запрос упаковки изменён в другой вкладке. Нажмите «Повторить восстановление запроса», чтобы открыть сохранённый запрос.');};
    if(renderScope.current.scope!==scope||renderScope.current.attempt!==recoveryAttempt){renderScope.current={scope,attempt:recoveryAttempt};owner.current++;}
    const view=renderScope.current,ownsView=()=>renderScope.current===view;
    const apply=useCallback((next:ToolBuild)=>{
        jobKnown.current=true;setError('');setJob(previous=>acceptBuildProgress(previous,next));setJobId(next.id);
        if(next.state==='CANCELLED')setCancelled(true);
        if(saveBuildCheckpoint(scope,'job',next.id))savePendingBuild(scope);
        setPendingKey(undefined);setUnresolvedKey(undefined);
    },[scope]);

    useEffect(()=>{
        const current=++owner.current,savedJob=readBuildCheckpoint(scope,'job'),savedRequest=readPendingBuild(scope);
        busy.current=false;jobKnown.current=false;saved.current=undefined;cancellation.current=undefined;replayedCancellation.current=undefined;cancelWanted.current=false;cancelBusy.current=false;saveInFlight.current=undefined;
        setLoadedScope(scope);setJob(undefined);setJobId(undefined);setPendingKey(undefined);setUnresolvedKey(undefined);
        setDraft(undefined);setError('');setStorageError('');setSubmitting(false);setRecovering(true);setRecoveryBlocked(false);setCancelIntent(undefined);setCancelling(false);setCancelled(false);setCancelAck(undefined);setArchiving(false);archiveBusy.current=false;
        void readStoredBuildRecovery(scope,{jobId:savedJob,requestKey:savedRequest}).then(({draft:record,cancellation:intent,archivedCheckpoint})=>{
            if(owner.current!==current)return;
            saved.current=record;setDraft(record);cancellation.current=intent;setCancelIntent(intent);cancelWanted.current=!!intent;
            if(intent){setJobId(undefined);jobKnown.current=false;return;}
            if(record){jobKnown.current=false;setJobId(undefined);setPendingKey(record.request.requestKey);}
            else if(!archivedCheckpoint){jobKnown.current=!!savedJob;setJobId(savedJob);setPendingKey(savedJob?undefined:savedRequest);}
        }).catch(cause=>{
            if(owner.current===current){setRecoveryBlocked(true);setStorageError(errorMessage(cause,'Не удалось восстановить исходный запрос. Новая сборка не отправлена.'));}
        }).finally(()=>{if(owner.current===current)setRecovering(false);});
        return()=>{owner.current++;cancelRequest.current?.abort();cancelRequest.current=undefined;};
    },[scope,apply,recoveryAttempt]);

    useEffect(()=>{
        const current=owner.current;let closed=false;setArchived([]);setArchiveError('');
        void listStoredBuildArchives(scope).then(records=>{if(!closed&&owner.current===current)setArchived(records);}).catch(cause=>{if(!closed&&owner.current===current)setArchiveError(errorMessage(cause,'Не удалось прочитать сохранённые запросы. Повторите восстановление.'));});
        return()=>{closed=true;};
    },[scope,recoveryAttempt,archiveRevision]);

    useEffect(()=>{
        if(loadedScope!==scope)return;
        if(jobId)saveBuildCheckpoint(scope,'job',jobId);
        else if(pendingKey||unresolvedKey)saveBuildCheckpoint(scope,'request',pendingKey||unresolvedKey);
    },[location.pathname,location.search,location.hash,loadedScope,scope,jobId,pendingKey,unresolvedKey]);

    useEffect(()=>{
        if(!pendingKey||jobId||cancelIntent||cancelWanted.current)return;
        const controller=new AbortController(),current=owner.current;
        void resumePendingBuild(pendingKey,packagingApi.lookup,controller.signal,()=>{
            if(owner.current===current&&!controller.signal.aborted)setError('Проверяем сохранённый запрос. Новую сборку не запускаем.');
        }).then(next=>{if(owner.current===current&&!controller.signal.aborted&&!cancelWanted.current)apply(next);}).catch(cause=>{
            if(owner.current!==current||controller.signal.aborted||cancelWanted.current)return;
            // Даже определённый отказ lookup не разрешает изменить сохранённое тело POST.
            setUnresolvedKey(pendingKey);setPendingKey(undefined);
            setError(errorMessage(cause,'Не удалось найти запрос сборки. Проверьте операции перед новой попыткой.'));
        });
        return()=>controller.abort();
    },[pendingKey,jobId,apply,cancelIntent]);

    const replayCancel=useCallback(async(intent:StoredBuildCancellation):Promise<void>=>{
        if(cancelBusy.current)return;
        replayedCancellation.current=intent;
        const current=owner.current,controller=new AbortController();cancelRequest.current=controller;cancelBusy.current=true;setCancelling(true);setCancelAck(undefined);setError('');
        try{
            const response=intent.target==='request'?await packagingApi.cancelRequest(intent.id,controller.signal):undefined;
            const next=response?response.build:await packagingApi.cancel(intent.id,controller.signal);
            if(owner.current!==current||cancellation.current!==intent)return;
            if(next)apply(next);
            if(next?.state==='CANCELLING'&&!next.publicationStartedAt&&next.requestKey&&(intent.target==='request'?intent.id===next.requestKey:intent.id===next.id))setCancelAck({id:next.id,requestKey:next.requestKey,state:'CANCELLING'});
            if(response?.state==='CANCELLED'||next?.state==='CANCELLED'){
                jobKnown.current=true;setCancelled(true);setPendingKey(undefined);setUnresolvedKey(undefined);setSubmitting(false);return;
            }
            if(next&&(finished(next)||next.publicationStartedAt)){
                const cleared=await clearStoredBuildCancellation(scope,intent);
                if(owner.current!==current||cancellation.current!==intent)return;
                if(!cleared){storageConflict();return;}
                cancellation.current=undefined;cancelWanted.current=false;setCancelIntent(undefined);
                if(next.publicationStartedAt&&!finished(next))setError('Публикация уже началась. Отменить её нельзя — дождитесь результата.');
            }
        }catch(cause){if(owner.current===current&&cancellation.current===intent)setError(errorMessage(cause,'Ответ на отмену не получен. Повторите отмену; новая сборка не запускается.'));}
        finally{if(cancelRequest.current===controller)cancelRequest.current=undefined;if(owner.current===current){cancelBusy.current=false;setCancelling(false);}}
    },[scope,apply]);

    useEffect(()=>{if(cancelIntent&&!cancelled&&(replayedCancellation.current!==cancelIntent||job&&finished(job)))void replayCancel(cancelIntent);},[cancelIntent,replayCancel,job?.state]);

    useEffect(()=>{
        if(!jobId||job&&finished(job))return;
        let closed=false,timer:ReturnType<typeof setTimeout>;const controller=new AbortController();
        const current=owner.current,generation=observation.current;
        const poll=async()=>{
            try{const next=await packagingApi.get(jobId,controller.signal);if(!closed&&owner.current===current&&observation.current===generation)apply(next);}
            catch(cause){
                if(closed||owner.current!==current||observation.current!==generation)return;
                if(cancellation.current){if(isAxiosError(cause)&&[401,403,404].includes(cause.response?.status??0))setCancelAck(undefined);setError(errorMessage(cause,'Не удалось проверить отмену. Повторите отмену сохранённого запроса.'));}
                else if(isAxiosError(cause)&&[403,404].includes(cause.response?.status??0)){
                    closed=true;busy.current=false;jobKnown.current=false;setSubmitting(false);setJobId(undefined);setJob(undefined);saveBuildCheckpoint(scope,'job');
                    if(saved.current){setUnresolvedKey(saved.current.request.requestKey);}
                    setError(cause.response?.status===404?'Сборка не найдена. Проверьте сохранённый запрос перед повтором.':'Доступ к сборке изменился. Обновите данные профиля.');
                }else setError(errorMessage(cause,'Не удалось обновить прогресс. Повторяем подключение…'));
            }finally{if(!closed)timer=setTimeout(()=>{void poll();},2000);}
        };
        timer=setTimeout(()=>{void poll();},1000);
        return()=>{closed=true;controller.abort();clearTimeout(timer);};
    },[jobId,job?.state,apply,scope]);

    const send=async(request:ToolBuildRequest,retained=false):Promise<void>=>{
        if(!ownsView()||archiveBusy.current||busy.current||recovering||recoveryBlocked||cancelWanted.current||pendingKey||jobId&&(!job||!finished(job)))return;
        const current=owner.current,generation=++submission.current;busy.current=true;setSubmitting(true);setError('');
        const owns=()=>owner.current===current&&submission.current===generation;
        try{
            const storing=saveStoredBuildDraft(scope,request);saveInFlight.current=storing;
            const record=await storing;
            if(!owns())return;
            saved.current=record;setDraft(record);jobKnown.current=false;
            if(cancelWanted.current)return;
            // IndexedDB commit already preserves UUID+body when History/localStorage is unavailable.
            saveBuildCheckpoint(scope,'request',record.request.requestKey);
            setUnresolvedKey(undefined);setPendingKey(record.request.requestKey);
            try{const next=await packagingApi.create(record.request);if(owns()&&!cancelWanted.current)apply(next);}
            catch(cause){
                if(!owns()||jobKnown.current||cancelWanted.current)return;
                if(isAxiosError(cause)&&[400,401,403,404,409,413,422].includes(cause.response?.status??0)){
                    setPendingKey(undefined);
                    if(retained)setUnresolvedKey(record.request.requestKey);
                    else {
                        try {
                            const cleared=await clearStoredBuildDraft(scope,record.request.requestKey);
                            if(!owns())return;
                            if(cleared===false){storageConflict();return;}
                            saved.current=undefined;setDraft(undefined);savePendingBuild(scope);setUnresolvedKey(undefined);
                        }catch{if(owns())setUnresolvedKey(record.request.requestKey);}
                    }
                }
                setError(errorMessage(cause,'Ответ не получен. Проверяем сохранённый запрос сборки.'));
            }
        }catch(cause){
            if(owns()&&!cancelWanted.current){
                setError(errorMessage(cause,'Не удалось сохранить точный запрос. Сборка не отправлена.'));
                // Another tab may already own this scope. Read its request instead of overwriting it.
                try{
                    const {draft:record,cancellation:intent}=await readStoredBuildRecovery(scope);
                    if(owns()){
                        if(record){saved.current=record;setDraft(record);}
                        if(intent){cancellation.current=intent;cancelWanted.current=true;setCancelIntent(intent);setPendingKey(undefined);}
                        else if(record)setPendingKey(record.request.requestKey);
                    }
                }catch{/* Первый отказ хранения уже показан. */}
            }
        }finally{if(owns()){saveInFlight.current=undefined;busy.current=false;setSubmitting(false);}}
    };
    const submit=async(body:Omit<ToolBuildRequest,'requestKey'>):Promise<void>=>{
        if(!ownsView())return;
        if(saved.current||unresolvedKey){setError('Сначала восстановите сохранённый запрос или вернитесь к исходникам завершённой сборки.');return;}
        await send({...body,requestKey:crypto.randomUUID()});
    };
    const retrySaved=async():Promise<void>=>{
        if(!ownsView())return;
        const record=saved.current;
        if(!record||record.request.requestKey!==unresolvedKey){setError('Точный исходный запрос недоступен. Проверьте его состояние в операциях; другая форма не будет отправлена с прежним UUID.');return;}
        await send(record.request,true);
    };
    const recheck=():void=>{if(ownsView()&&unresolvedKey){setPendingKey(unresolvedKey);setUnresolvedKey(undefined);setError('');}};
    const cancel=async():Promise<void>=>{
        if(!ownsView()||archiveBusy.current||cancelBusy.current||cancelWanted.current||recovering||recoveryBlocked||cancelled||job&&(finished(job)||!!job.publicationStartedAt))return;
        const current=owner.current;cancelWanted.current=true;submission.current++;busy.current=false;setSubmitting(false);setCancelling(true);setError('');
        try{
            const record=saveInFlight.current?await saveInFlight.current:saved.current;
            if(owner.current!==current)return;
            saveInFlight.current=undefined;if(record){saved.current=record;setDraft(record);}
            const key=record?.request.requestKey||pendingKey||unresolvedKey||job?.requestKey;
            const id=key||jobId;
            if(!id){cancelWanted.current=false;setError('Запрос сборки ещё не сохранён. Проверьте состояние и повторите отмену.');return;}
            const intent=await saveStoredBuildCancellation(scope,key?'request':'job',id,record?.request.requestKey);
            if(owner.current!==current)return;
            cancellation.current=intent;setCancelIntent(intent);setPendingKey(undefined);setUnresolvedKey(undefined);
            await replayCancel(intent);
        }catch(cause){if(owner.current===current){setError(errorMessage(cause,'Не удалось сохранить отмену. Повторите восстановление запроса.'));setRecoveryBlocked(true);}}
        finally{if(owner.current===current&&!cancelBusy.current)setCancelling(false);}
    };
    const reset=async():Promise<boolean>=>{
        if(!ownsView()||archiveBusy.current||busy.current||cancelBusy.current||recoveryBlocked||!cancelled&&(pendingKey||unresolvedKey||cancelIntent||jobId&&(!job||!finished(job))))return false;
        const current=owner.current;observation.current++;busy.current=true;setSubmitting(true);
        try{
            const cleared=cancellation.current?await clearStoredBuildDraft(scope,saved.current?.request.requestKey,cancellation.current):await clearStoredBuildDraft(scope,saved.current?.request.requestKey);
            if(owner.current!==current)return false;
            if(cleared===false){storageConflict();return false;}
            saved.current=undefined;setDraft(undefined);cancellation.current=undefined;cancelWanted.current=false;setCancelIntent(undefined);setCancelled(false);setPendingKey(undefined);setUnresolvedKey(undefined);jobKnown.current=false;setJob(undefined);setJobId(undefined);setError('');saveBuildCheckpoint(scope,'job');savePendingBuild(scope);setArchiveRevision(value=>value+1);return true;
        }catch(cause){if(owner.current===current)setError(errorMessage(cause,'Не удалось завершить восстановление запроса.'));return false;}
        finally{if(owner.current===current){busy.current=false;setSubmitting(false);}}
    };
    const canDetach=!!cancelAck&&cancelAck.id===job?.id&&cancelAck.requestKey===job.requestKey&&job.state==='CANCELLING'&&!job.publicationStartedAt&&!!cancelIntent&&!cancelled&&!cancelling&&!recovering&&!recoveryBlocked;
    const detach=async():Promise<boolean>=>{
        if(!ownsView()||archiveBusy.current||!canDetach||!cancellation.current||!cancelAck)return false;
        const current=owner.current;archiveBusy.current=true;setArchiving(true);setError('');
        try{
            const committed=await archiveStoredBuildCancellation(scope,saved.current?.request.requestKey,cancellation.current,cancelAck);
            if(owner.current!==current)return false;if(!committed){storageConflict();return false;}
            // Invalidate reads only after commit; a failed archive keeps the current polling path alive.
            observation.current++;submission.current++;saved.current=undefined;cancellation.current=undefined;cancelWanted.current=false;jobKnown.current=false;saveInFlight.current=undefined;busy.current=false;
            renderScope.current={scope,attempt:recoveryAttempt};
            setDraft(undefined);setJob(undefined);setJobId(undefined);setCancelIntent(undefined);setCancelAck(undefined);setCancelled(false);setPendingKey(undefined);setUnresolvedKey(undefined);setSubmitting(false);
            saveBuildCheckpoint(scope,'job');savePendingBuild(scope);setArchiveRevision(value=>value+1);return true;
        }catch(cause){if(owner.current===current)setError(errorMessage(cause,'Не удалось сохранить запрос. Текущая отмена и исходники сохранены.'));return false;}
        finally{if(owner.current===current){archiveBusy.current=false;setArchiving(false);}}
    };
    const restoreArchived=async(key:string):Promise<void>=>{
        if(!ownsView()||archiveBusy.current||busy.current||recovering||recoveryBlocked||saved.current||cancelIntent||pendingKey||unresolvedKey||jobId)return;
        const current=owner.current;archiveBusy.current=true;setArchiving(true);setArchiveError('');
        try{
            if(!await restoreStoredBuildArchive(scope,key)){if(owner.current===current)setArchiveError('Сначала завершите текущий запрос или вернитесь к его исходникам. Сохранённый запрос не изменён.');return;}
            if(owner.current===current){renderScope.current={scope,attempt:recoveryAttempt};setRecoveryAttempt(value=>value+1);}
        }catch(cause){if(owner.current===current)setArchiveError(errorMessage(cause,'Не удалось восстановить сохранённый запрос.'));}
        finally{if(owner.current===current){archiveBusy.current=false;setArchiving(false);}}
    };
    const currentView=loadedScope===scope;
    return{job:currentView?job:undefined,submitting,error:currentView?storageError||error:'',submit,reset,recheck,retrySaved,cancel,retryCancel:()=>ownsView()&&!archiveBusy.current?(cancellation.current?replayCancel(cancellation.current):cancel()):Promise.resolve(),
        canDetach:currentView&&canDetach,detach,archiving:currentView&&archiving,archived:currentView?archived:[],archiveError:currentView?archiveError:'',restoreArchived,
        canRestoreArchived:currentView&&!recovering&&!recoveryBlocked&&!archiving&&!submitting&&!draft&&!cancelIntent&&!pendingKey&&!unresolvedKey&&!jobId,
        cancelling:currentView&&cancelling,cancelPending:currentView&&!!cancelIntent&&!cancelled,cancelled:currentView&&(cancelled||job?.state==='CANCELLED'),
        canCancel:currentView&&!recovering&&!recoveryBlocked&&!cancelled&&!cancelIntent&&(!job||!finished(job)&&!job.publicationStartedAt)&&!!(submitting||pendingKey||unresolvedKey||jobId),
        draft:currentView?draft:undefined,recovering,recoveryBlocked,retryRecovery:()=>{if(ownsView())setRecoveryAttempt(value=>value+1);},unresolved:currentView&&!!unresolvedKey,
        active:!currentView||recovering||submitting||cancelling||archiving||!cancelled&&(!!cancelIntent||!!pendingKey||!!jobId&&(!job||!finished(job)))};
}
