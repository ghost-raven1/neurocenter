import {useCallback,useEffect,useRef,useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {projectSnapshotsApi} from './api';
import {clearSnapshotIntent,readSnapshotIntent,saveSnapshotIntent,snapshotDraftScope} from './snapshotDraftStore';
import type {SnapshotIntent,SnapshotReceipt} from './types';
interface State {intent?:SnapshotIntent;receipt?:SnapshotReceipt;loading:boolean;busy:boolean;blocked:boolean;missing:boolean;error:string;notice:string}
const empty=():State=>({loading:true,busy:false,blocked:false,missing:false,error:'',notice:''});
/** A stale effect cannot keep the lock after replay or release a newer flight. */
interface Context {key:string;alive:boolean;locked?:()=>boolean;sequence:number;confirmed?:string;controller?:AbortController}
/** Durable intent survives unknown HTTP outcomes. Reading a missing receipt never authorizes a second intent. */
export function useSnapshotIntent(email:string,projectId:string,canWrite:boolean,onConfirmed:()=>void){
    const {scope,captureOwner}=useAuthRequestOwner(),key=JSON.stringify([scope,projectId]);
    const contextRef=useRef<Context>({key,alive:true,sequence:0});
    if(contextRef.current.key!==key){contextRef.current.alive=false;contextRef.current.controller?.abort();contextRef.current={key,alive:true,sequence:0};}
    const context=contextRef.current,storageScope=snapshotDraftScope(email,projectId);
    const [stored,setStored]=useState<{context:Context;value:State}>(()=>({context,value:empty()}));
    const state=stored.context===context?stored.value:empty(),stateRef=useRef(state),permission=useRef(canWrite),callback=useRef(onConfirmed);
    stateRef.current=state;permission.current=canWrite;callback.current=onConfirmed;
    const update=(patch:Partial<State>)=>setStored(previous=>({context,value:{...(previous.context===context?previous.value:empty()),...patch}}));
    const token=()=>{const owns=captureOwner();return()=>context.alive&&contextRef.current===context&&owns();};
    const finish=async(intent:SnapshotIntent,receipt:SnapshotReceipt,current:()=>boolean)=>{
        if(!current())return;
        update({intent,receipt,missing:false,blocked:false,error:''});
        if(context.confirmed!==intent.input.requestKey){context.confirmed=intent.input.requestKey;callback.current();}
        const cleared=await clearSnapshotIntent(storageScope,projectId,intent.input.requestKey);
        if(!current())return;
        if(!cleared)throw new Error('В другой вкладке уже сохранён новый запрос. Обновите состояние перед действием.');
        update({intent:undefined,receipt,missing:false,notice:'Сервер подтвердил запрос.'});
    };
    const refresh=useCallback(async()=>{
        const current=token();if(context.locked?.()||!email||!current())return;context.locked=current;const sequence=++context.sequence;
        update({loading:true,error:'',notice:''});
        try{
            const intent=await readSnapshotIntent(storageScope,projectId);if(!current()||sequence!==context.sequence)return;
            update({intent,receipt:undefined,missing:false,blocked:false});
            if(intent){
                const receipt=await projectSnapshotsApi.lookup(intent);if(!current()||sequence!==context.sequence)return;
                if(receipt)await finish(intent,receipt,current);else update({missing:true});
            }
        }catch(cause){if(current())update({blocked:true,error:errorMessage(cause,'Состояние запроса не подтверждено. Обновите его перед новым действием.')});}
        finally{if(context.locked===current){context.locked=undefined;if(current())update({loading:false});}}
    // Context identity fences owner/project ABA independently from later effect cleanup.
    },[context,email,projectId,storageScope,captureOwner]);
    useEffect(()=>{
        context.alive=true;void refresh();
        return()=>{context.alive=false;context.sequence++;context.controller?.abort();};
    },[context,refresh]);
    const send=async(intent:SnapshotIntent,isRetry=false)=>{
        const current=token();
        if(!current()||!permission.current||context.locked?.()||stateRef.current.loading||stateRef.current.blocked||intent.projectId!==projectId
            ||!isRetry&&!!stateRef.current.intent||isRetry&&stateRef.current.intent?.input.requestKey!==intent.input.requestKey)return;
        context.locked=current;update({busy:true,error:'',notice:''});let sent=false;
        try{
            const saved=await saveSnapshotIntent(storageScope,intent);if(!current())return;
            update({intent:saved,receipt:undefined,missing:false});
            if(!permission.current)return;
            context.controller=new AbortController();sent=true;
            const receipt=await projectSnapshotsApi.submit(saved,context.controller.signal);
            if(current())await finish(saved,receipt,current);
        }catch(cause){if(current())update({blocked:!sent,error:errorMessage(cause,sent?'Ответ неизвестен. Проверьте состояние или повторите сохранённый запрос. UUID и подтверждение сохраняются.':'Подтверждение не сохранено. Запрос не отправлен.')});}
        finally{if(context.locked===current){context.controller=undefined;context.locked=undefined;if(current())update({busy:false});}}
    };
    const abandon=async()=>{
        const current=token(),intent=stateRef.current.intent;
        if(!current()||!permission.current||context.locked?.()||!intent)return;
        context.locked=current;update({busy:true,error:'',notice:''});
        try{
            if(!stateRef.current.receipt){
                try{await projectSnapshotsApi.cancelRequest(intent);}
                catch(cause){
                    if((cause as {response?:{status?:number}})?.response?.status!==409)throw cause;
                    const receipt=await projectSnapshotsApi.lookup(intent);if(!current())return;
                    if(!receipt)throw cause;
                    await finish(intent,receipt,current);return;
                }
            }
            if(!current())return;
            if(!await clearSnapshotIntent(storageScope,projectId,intent.input.requestKey))throw new Error('В другой вкладке уже сохранён другой запрос. Обновите состояние.');
            if(current())update({intent:undefined,receipt:undefined,missing:false,blocked:false,notice:'Сохранённый запрос закрыт. Его запоздалый повтор не запустит новое действие.'});
        }catch(cause){if(current())update({error:errorMessage(cause,'Подтверждение отмены не получено. Сохранённый запрос остаётся доступным.')});}
        finally{if(context.locked===current){context.locked=undefined;if(current())update({busy:false});}}
    };
    return {...state,refresh,submit:(intent:SnapshotIntent)=>send(intent),repeat:()=>stateRef.current.intent?send(stateRef.current.intent,true):Promise.resolve(),abandon};
}
