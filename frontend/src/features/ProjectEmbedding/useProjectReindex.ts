import {useCallback,useEffect,useRef,useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import type {ICatalogModel} from '../ModelCatalog/types';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {projectEmbeddingApi,sha} from './model';
import {projectReindexApi,reindexPending,type IProjectReindexPlan,type IReindexConnectionTarget} from './reindex';

/** Смена модели принадлежит точному проекту и owner; поздний ответ не запускает следующий POST. */
export function useProjectReindex(projectId:string|undefined,onApplied?:()=>void){
    const {scope,captureOwner}=useAuthRequestOwner();
    const [plan,setPlan]=useState<IProjectReindexPlan>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
    const alive=useRef(true),generation=useRef(0),version=useRef(0),lock=useRef(false),completed=useRef(''),callback=useRef(onApplied);
    callback.current=onApplied;
    const draft=useRef<{modelId:string;modelPin:string;revision:number;requestKey:string;connection?:IReindexConnectionTarget}>();
    const accept=useCallback((value:IProjectReindexPlan|undefined)=>{
        if(value&&value.projectId!==projectId)throw new Error('Ответ относится к другому проекту.');
        setPlan(value);
        if(value&&['stale','cancelled'].includes(value.state))draft.current=undefined;
        if(value?.state==='applied'&&completed.current!==value.id){completed.current=value.id;draft.current=undefined;callback.current?.();}
    },[projectId]);
    useEffect(()=>{
        alive.current=true;generation.current++;lock.current=false;setBusy(false);setError('');setPlan(undefined);draft.current=undefined;completed.current='';
        if(!projectId)return()=>{alive.current=false;generation.current++;};
        const ticket=generation.current,readVersion=version.current,owns=captureOwner();
        void projectReindexApi.latest(projectId).then(value=>{if(alive.current&&ticket===generation.current&&readVersion===version.current&&owns())accept(value??undefined);})
            .catch(cause=>{if(alive.current&&ticket===generation.current&&readVersion===version.current&&owns())setError(errorMessage(cause,'Не удалось прочитать состояние переиндексации.'));});
        return()=>{alive.current=false;generation.current++;};
    },[scope,projectId,captureOwner,accept]);
    useEffect(()=>{
        if(!projectId||!reindexPending(plan))return;
        const ticket=generation.current,owns=captureOwner();let stopped=false,running=false;
        const poll=async()=>{
            if(stopped||running||lock.current||!plan)return;running=true;const readVersion=version.current;
            try{const next=await projectReindexApi.get(projectId,plan.id);if(!stopped&&alive.current&&ticket===generation.current&&readVersion===version.current&&owns()){accept(next);setError('');}}
            catch(cause){if(!stopped&&alive.current&&ticket===generation.current&&readVersion===version.current&&owns())setError(errorMessage(cause,'Не удалось проверить ход переиндексации.'));}
            finally{running=false;}
        };
        const timer=setInterval(()=>{void poll();},1500);return()=>{stopped=true;clearInterval(timer);};
    },[plan?.id,plan?.state,plan?.local?.state,projectId,captureOwner,accept]);
    const request=async(model:ICatalogModel,revision?:number,connection?:IReindexConnectionTarget)=>{
        const owns=captureOwner(),ticket=generation.current,current=()=>alive.current&&ticket===generation.current&&owns();
        if(!projectId||!current()||lock.current||reindexPending(plan)||plan?.state==='needs_input')return;
        lock.current=true;version.current++;setBusy(true);setError('');
        try{
            if(!sha(model.modelPin))throw new Error('Обновите каталог: у модели отсутствует проверенный pin.');
            const previous=draft.current;
            if(!previous||previous.modelId!==model.id||previous.modelPin!==model.modelPin||revision!==undefined&&previous.revision!==revision||JSON.stringify(previous?.connection)!==JSON.stringify(connection)){
                const expectedRevision=revision??(await projectEmbeddingApi.read(projectId)).revision;
                if(!current())return;draft.current={modelId:model.id,modelPin:model.modelPin,revision:expectedRevision,requestKey:crypto.randomUUID(),...connection?{connection}:{}};
            }
            if(!current()||!draft.current)return;
            const input=draft.current;
            const next=await projectReindexApi.create(projectId,{expectedSelectionRevision:input.revision,modelId:input.modelId,expectedModelPin:input.modelPin,requestKey:input.requestKey,...input.connection?{connection:input.connection}:{}});
            if(current())accept(next);
        }catch(cause){if(current())setError(errorMessage(cause,'Не удалось подготовить смену модели. Повтор использует прежний intent.'));}
        finally{if(current()){lock.current=false;setBusy(false);}}
    };
    const action=async(kind:'start'|'cancel'|'retry'|'retryLocal')=>{
        const owns=captureOwner(),ticket=generation.current,current=()=>alive.current&&ticket===generation.current&&owns();
        if(!projectId||!current()||lock.current||!plan)return;lock.current=true;version.current++;setBusy(true);setError('');
        try{const next=await projectReindexApi[kind](projectId,plan);if(current())accept(next);}
        catch(cause){if(current())setError(errorMessage(cause,'Не удалось изменить состояние переиндексации.'));}
        finally{if(current()){lock.current=false;setBusy(false);}}
    };
    return {plan,busy,error,pending:reindexPending(plan),request,start:()=>action('start'),cancel:()=>action('cancel'),retry:()=>action('retry'),retryLocal:()=>action('retryLocal')};
}
