import {useEffect,useRef,useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {bridgeApi,type IBridgeJob} from '../McpBridge/api';
import {createBridgeRequestKey} from '../McpBridge/bridgeRequestKey';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {emptyWorkflowDraft,readWorkflowDraft,workflowAgentIdentity,workflowChecks,workflowStorageKey,WORKFLOW_INPUT_MAX_BYTES,type WorkflowDraft,type WorkflowIntent} from './model';

interface Target {deviceId:string;expectedBindingId:string;expectedInstanceId:string;}

/** Persist intent before dispatch; unknown acceptance blocks a fresh key and keeps an exact replay. */
export function useAgentMethodWorkflow(projectId:string){
    const {scope,captureOwner}=useAuthRequestOwner(),key=workflowStorageKey(scope,projectId);
    const [initial]=useState(()=>{try{return {draft:readWorkflowDraft(localStorage,key,projectId),error:''};}catch{return {draft:emptyWorkflowDraft(),error:'Сохранённая задача не прочитана. Проверьте историю заданий; новая отправка заблокирована.'};}});
    const [draft,setDraft]=useState(initial.draft),[storageError,setStorageError]=useState(initial.error);
    const [damaged,setDamaged]=useState(!!initial.error);
    const [error,setError]=useState(''),[busy,setBusy]=useState(false),[canReplay,setCanReplay]=useState(false),[accepted,setAccepted]=useState<IBridgeJob>();
    const latest=useRef(draft),working=useRef(false),alive=useRef(true);latest.current=draft;
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
    const persist=(next:WorkflowDraft):void=>{
        try{localStorage.setItem(key,JSON.stringify(next));setStorageError('');latest.current=next;setDraft(next);}
        catch{setStorageError('Не удалось сохранить задачу на этом устройстве. Отправка не выполняется; проверьте доступ к хранилищу браузера.');throw Error('Не удалось сохранить задачу.');}
    };
    const update=(patch:Partial<Pick<WorkflowDraft,'method'|'instruction'|'checks'|'agentId'>>):void=>{
        if(storageError||latest.current.pending||working.current)return;
        const next={...latest.current,...patch};
        try{persist(next);}catch{latest.current=next;setDraft(next);}
    };
    const confirm=(job:IBridgeJob,intent:WorkflowIntent):void=>{
        if(job.kind!==intent.kind||job.deviceId!==intent.deviceId||job.projectId!==intent.projectId||job.workflowId!==intent.requestKey
            ||job.bindingId!==intent.expectedBindingId||job.expectedInstanceId!==intent.expectedInstanceId)throw Error('Сервер не подтвердил исходную папку и задачу. Проверьте отправку заново.');
        const agent=workflowAgentIdentity(job.agent);
        if(intent.workflow.agentId?(!agent||agent.agentId!==intent.workflow.agentId||agent.agentsRevision!==intent.workflow.expectedAgentsRevision):job.agent!=null)throw Error('Сервер не подтвердил выбранного агента и ревизию. Проверьте отправку заново.');
        setAccepted(job);persist({...latest.current,pending:undefined,rejectedStatus:undefined});setCanReplay(false);
    };
    const send=async(intent:WorkflowIntent):Promise<void>=>{
        if(working.current)return;working.current=true;const owns=captureOwner();setBusy(true);setError('');setCanReplay(false);
        try{
            persist({...latest.current,pending:intent,rejectedStatus:undefined});
            const job=await bridgeApi.create(intent);
            if(alive.current&&owns())confirm(job,intent);
        }catch(cause){if(alive.current&&owns()){
            const status=(cause as {response?:{status?:number}})?.response?.status;
            if((status===400||status===409)&&latest.current.pending?.requestKey===intent.requestKey){try{persist({...latest.current,rejectedStatus:status});}catch{/* Keep recovery blocked if its rejection could not be persisted. */}}
            setError(errorMessage(cause,'Исход отправки неизвестен. Проверьте принятие задачи.'));
        }}
        finally{working.current=false;if(alive.current&&owns())setBusy(false);}
    };
    const start=async(target:Target,expectedAgentsRevision?:number):Promise<void>=>{
        if(storageError||latest.current.pending||working.current)return;
        try{
            const value=latest.current;
            if(!value.instruction.trim()||new TextEncoder().encode(value.instruction).length>WORKFLOW_INPUT_MAX_BYTES||!value.checks.length)throw Error('Опишите задачу в пределах 16 КиБ и выберите хотя бы одну проверку.');
            if(value.agentId&&(!Number.isSafeInteger(expectedAgentsRevision)||Number(expectedAgentsRevision)<1))throw Error('Обновите агентов проекта и подтвердите выбранного исполнителя.');
            await send({kind:'run-agent-method-workflow',projectId,...target,requestKey:createBridgeRequestKey(),workflow:{method:value.method,instruction:value.instruction,
                checks:workflowChecks(value.checks),...(value.agentId?{agentId:value.agentId,expectedAgentsRevision:expectedAgentsRevision!}:{})}});
        }catch(cause){setError(errorMessage(cause,'Не удалось подготовить задачу.'));}
    };
    const recover=async():Promise<void>=>{
        const intent=latest.current.pending;if(!intent||working.current)return;
        working.current=true;const owns=captureOwner();setBusy(true);setError('');setCanReplay(false);
        try{const receipt=await bridgeApi.request(intent.requestKey);if(receipt.requestKey!==intent.requestKey)throw Error('Квитанция относится к другому запросу.');if(alive.current&&owns())confirm(receipt.job,intent);}
        catch(cause){if(alive.current&&owns()){
            setCanReplay((cause as {response?:{status?:number}})?.response?.status===404);
            setError(errorMessage(cause,'Проверка принятия пока недоступна. Задача сохранена.'));
        }}finally{working.current=false;if(alive.current&&owns())setBusy(false);}
    };
    const clearDamagedCopy=():void=>{
        if(!storageError||working.current)return;
        try{localStorage.removeItem(key);const next=emptyWorkflowDraft();latest.current=next;setDraft(next);setStorageError('');setDamaged(false);setError('');}
        catch{setStorageError('Хранилище браузера недоступно. Откройте историю заданий и восстановите доступ к локальному хранилищу.');}
    };
    const retrySave=():void=>{if(damaged||working.current)return;try{persist(latest.current);}catch{/* Keep the current input and storage error. */}};
    const canDiscard=canReplay&&!!draft.rejectedStatus;
    const discardRejected=():void=>{
        if(!canReplay||!latest.current.rejectedStatus||working.current)return;
        try{persist({...latest.current,pending:undefined,rejectedStatus:undefined});setCanReplay(false);setError('');}catch{/* The original intent remains recoverable. */}
    };
    return {draft,error,storageError,damaged,busy,canReplay,canDiscard,accepted,update,start,recover,clearDamagedCopy,retrySave,discardRejected,
        replay:()=>latest.current.pending?send(latest.current.pending):Promise.resolve()};
}
