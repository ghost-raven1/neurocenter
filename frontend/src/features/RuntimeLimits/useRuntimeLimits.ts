import {useCallback,useEffect,useRef,useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {durableJournalOwner} from '../UserBlock/durableJournalOwner';
import {baseApi} from '../../core/api';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {runtimeLimitInput,runtimeLimitPolicy,type RuntimeLimitAdminView,type RuntimeLimitInput,type RuntimeLimitPolicy,type RuntimeLimitReceipt} from '@neurocenter/runtime-limits';

const copy=(policy:RuntimeLimitPolicy):RuntimeLimitPolicy=>({textKnowledge:{...policy.textKnowledge},ggufImport:{...policy.ggufImport}});
const status=(error:unknown)=>(error as {response?:{status?:number}})?.response?.status;

/** A pending policy request is owner/API-scoped; uncertain ACKs retry the exact saved intent. */
export function useRuntimeLimits(){
    const {scope,captureOwner}=useAuthRequestOwner();
    const user=useSelector((state:RootState)=>state.userBlock.user);
    const journalOwner=durableJournalOwner(user,baseApi.defaults.baseURL||window.location.origin);
    const journal='neurocenter:runtime-limits:'+journalOwner,ownerKey=JSON.stringify([scope,journalOwner]);
    const [view,setView]=useState<RuntimeLimitAdminView>(),[draft,setDraft]=useState<RuntimeLimitPolicy>(),[revision,setRevision]=useState(0);
    const [pending,setPending]=useState<RuntimeLimitInput>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
    const [stateOwner,setStateOwner]=useState(ownerKey),[journalError,setJournalError]=useState('');
    const activeJournal=useRef<string>();
    const request=useRef<AbortController>();
    const read=useCallback(async()=>{
        const owns=captureOwner();if(!journalOwner||!owns()||activeJournal.current!==ownerKey||request.current)return;
        const controller=new AbortController();request.current=controller;setBusy(true);setError('');
        try{
            const result=await baseApi.get<RuntimeLimitAdminView>('/api/runtime-limits/admin',{signal:controller.signal,timeout:10000});
            if(!owns()||activeJournal.current!==ownerKey||controller.signal.aborted)return;
            const policy=runtimeLimitPolicy(result.data.policy);setView({...result.data,policy});
            setDraft(previous=>{if(previous)return previous;setRevision(result.data.revision);return copy(policy);});
        }catch(cause){if(owns()&&activeJournal.current===ownerKey&&!controller.signal.aborted)setError(errorMessage(cause,'Не удалось прочитать действующие лимиты. Введённые значения сохранены.'));}
        finally{if(request.current===controller){request.current=undefined;if(owns()&&activeJournal.current===ownerKey)setBusy(false);}}
    },[captureOwner,ownerKey,journalOwner]);
    useEffect(()=>{
        activeJournal.current=ownerKey;setStateOwner(ownerKey);setView(undefined);setDraft(undefined);setRevision(0);setPending(undefined);setError('');setNotice('');setJournalError('');
        try{
            const raw=journalOwner?localStorage.getItem(journal):null;
            if(raw){if(raw.length>32768)throw Error();const saved=runtimeLimitInput(JSON.parse(raw));setPending(saved);setDraft(copy(saved.policy));setRevision(saved.expectedRevision);}
        }catch{setJournalError('Локальный журнал настройки повреждён. Исходные данные сохранены для восстановления; новые сохранения заблокированы.');}
        void read();return()=>{activeJournal.current=undefined;request.current?.abort();request.current=undefined;};
    },[journal,ownerKey,read]);
    const accepted=(value:RuntimeLimitReceipt,intent:RuntimeLimitInput)=>{
        if(!value||value.requestKey!==intent.requestKey||!Number.isSafeInteger(value.revision)||value.revision!==intent.expectedRevision+1
            ||typeof value.acceptedAt!=='string'||!Number.isFinite(Date.parse(value.acceptedAt))||typeof value.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(value.requestHash))throw Error('Квитанция не подтверждена. Ключ повтора сохранён.');
        const policy=runtimeLimitPolicy(value.policy);
        if(value.requestKey!==intent.requestKey||JSON.stringify(policy)!==JSON.stringify(intent.policy))throw Error('Квитанция не соответствует сохранённому запросу.');
        localStorage.removeItem(journal);setPending(undefined);setDraft(copy(policy));setRevision(value.revision);
        setView(previous=>previous&&previous.revision<=value.revision?{...previous,revision:value.revision,policy,updatedAt:value.acceptedAt}:previous);
        setNotice('Сохранена ревизия '+value.revision+'. Новые операции используют действующие лимиты.');
    };
    const save=async()=>{
        const owns=captureOwner();if(!owns()||activeJournal.current!==ownerKey||stateOwner!==ownerKey||journalError||request.current||!draft||!view)return;
        if(!pending&&(!view.configurationEnabled||revision!==view.revision||JSON.stringify(draft)===JSON.stringify(view.policy)))return;
        let intent:RuntimeLimitInput;
        try{intent=pending??runtimeLimitInput({expectedRevision:revision,requestKey:crypto.randomUUID(),policy:draft});localStorage.setItem(journal,JSON.stringify(intent));}
        catch(cause){setError(errorMessage(cause,'Не удалось сохранить ключ повтора в браузере. Настройка не отправлена.'));return;}
        const controller=new AbortController();request.current=controller;setPending(intent);setBusy(true);setError('');setNotice('');
        try{
            const result=await baseApi.patch<RuntimeLimitReceipt>('/api/runtime-limits/admin',intent,{signal:controller.signal,timeout:15000});
            if(owns()&&activeJournal.current===ownerKey&&!controller.signal.aborted)accepted(result.data,intent);
        }catch(cause){if(owns()&&activeJournal.current===ownerKey&&!controller.signal.aborted){
            if([400,409].includes(status(cause)??0)){localStorage.removeItem(journal);setPending(undefined);}
            setError(errorMessage(cause,'Результат не подтверждён. Проверьте квитанцию или повторите тот же запрос. Ввод сохранён.'));
        }}finally{if(request.current===controller){request.current=undefined;if(owns()&&activeJournal.current===ownerKey)setBusy(false);}}
    };
    const receipt=async()=>{
        const owns=captureOwner();if(!owns()||activeJournal.current!==ownerKey||stateOwner!==ownerKey||journalError||request.current||!pending)return;
        const controller=new AbortController();request.current=controller;setBusy(true);setError('');
        try{
            const result=await baseApi.get<RuntimeLimitReceipt>('/api/runtime-limits/admin/requests/'+pending.requestKey,{signal:controller.signal,timeout:10000});
            if(owns()&&activeJournal.current===ownerKey&&!controller.signal.aborted)accepted(result.data,pending);
        }catch(cause){if(owns()&&activeJournal.current===ownerKey&&!controller.signal.aborted)setError(status(cause)===404?'Квитанция пока не найдена. Это не подтверждает отказ: разрешён повтор прежнего запроса.':errorMessage(cause,'Не удалось проверить квитанцию. Ключ повтора сохранён.'));}
        finally{if(request.current===controller){request.current=undefined;if(owns()&&activeJournal.current===ownerKey)setBusy(false);}}
    };
    const ownsState=stateOwner===ownerKey;
    const stale=!!view&&revision!==view.revision,dirty=!!view&&!!draft&&JSON.stringify(draft)!==JSON.stringify(view.policy);
    return {view:ownsState?view:undefined,draft:ownsState?draft:undefined,pending:ownsState?pending:undefined,busy:!ownsState||busy,
        error:ownsState?journalError||error:'',notice:ownsState?notice:'',journalError:ownsState?journalError:'',stale:ownsState&&stale,dirty:ownsState&&dirty,read,save,receipt,
        change:(group:keyof RuntimeLimitPolicy,key:string,value:number|null)=>{if(ownsState&&activeJournal.current===ownerKey&&!journalError&&!busy&&!pending&&draft&&value!==null)setDraft({...draft,[group]:{...draft[group],[key]:value}});},
        useCurrent:()=>{if(ownsState&&activeJournal.current===ownerKey&&!journalError&&view&&!busy&&!pending){setDraft(copy(view.policy));setRevision(view.revision);setError('');}},
        keepDraft:()=>{if(ownsState&&activeJournal.current===ownerKey&&!journalError&&view&&!busy&&!pending)setRevision(view.revision);},
    };
}
