import {OPENCODE_GLOBAL_PROVIDERS_READ_JOB as READ,OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB as OPEN,normalizeGlobalProvidersRequest,type GlobalProvidersKind,type OpenCodeGlobalProvidersInventory} from '@neurocenter/opencode-local-providers';
import {errorMessage} from '../../common/utils/errorMessage';
import {globalRequestFingerprint,readProviderJob,record,terminal,uuid,type ProviderJob} from './model';
import type {LocalProvidersApi} from './api';
interface Options {owner:string;deviceId:string;role:string;storage?:Pick<Storage,'getItem'|'setItem'>;lock?:<T>(key:string,change:()=>T)=>Promise<T>;api:LocalProvidersApi;captureOwner:()=>()=>boolean;canRead:()=>boolean;canOpen:()=>boolean;requestKey?:()=>string;onChange:(value:LocalProvidersState)=>void}
export interface LocalProvidersState {busy:boolean;error:string;storageError:string;denied:boolean;jobs:Partial<Record<GlobalProvidersKind,ProviderJob>>;inventory?:OpenCodeGlobalProvidersInventory;canReplay:boolean;replayKinds:GlobalProvidersKind[]}
const kinds=[READ,OPEN];const initial=():LocalProvidersState=>({busy:false,error:'',storageError:'',denied:false,jobs:{},canReplay:false,replayKinds:[]});
const status=(error:unknown)=>(error as {response?:{status?:number}})?.response?.status;
/** Durable journals contain only request UUIDs; complete metadata is re-read under current authentication. */
export function createLocalProvidersController(options:Options){
    let state=initial(),active=false,epoch=0,abort:AbortController|undefined;
    const pending:Partial<Record<GlobalProvidersKind,string>>={},accepted:Partial<Record<GlobalProvidersKind,string>>={},confirmed:Partial<Record<GlobalProvidersKind,boolean>>={};
    const journalKey=(kind:GlobalProvidersKind)=>'neurocenter:global-providers:'+JSON.stringify([options.owner,options.deviceId,kind]);
    const publish=(patch:Partial<LocalProvidersState>)=>{state={...state,...patch};options.onChange(state);};
    function inventory(){const read=state.jobs[READ],open=state.jobs[OPEN],result=read?.result;
        return result&&(result.status==='checked'||result.status==='partial')&&(!pending[OPEN]||confirmed[OPEN])&&(!open||Date.parse(result.checkedAt)>Date.parse(open.updatedAt))?result.inventory:undefined;}
    function load(kind:GlobalProvidersKind){
        if(!options.storage)throw Error('Журнал браузера недоступен. Новые действия приостановлены; история доступна.');
        const raw=options.storage.getItem(journalKey(kind));if(raw===null){if(pending[kind])throw Error('Запрос удалён другой вкладкой. Перечитайте сохранённую отправку.');return;}
        let value:unknown;try{value=JSON.parse(raw);}catch{throw Error('Журнал повреждён. Исходная запись сохранена; новые действия приостановлены.');}
        if(!record(value)||Object.keys(value).some(key=>!['requestKey','version','jobId'].includes(key))||value.version!==1||!uuid(value.requestKey)||value.jobId!==undefined&&!uuid(value.jobId))throw Error('Журнал повреждён. Исходная запись сохранена; новые действия приостановлены.');
        if(pending[kind]!==value.requestKey){pending[kind]=value.requestKey;confirmed[kind]=false;accepted[kind]=undefined;}if(value.jobId)accepted[kind]=value.jobId as string;
    }
    async function rememberAccepted(kind:GlobalProvidersKind,key:string,id:string,current:()=>boolean){
        if(!current())return;accepted[kind]=id;
        try{if(!options.storage||!options.lock)throw Error();await options.lock(journalKey(kind),()=>{
            if(!current())return;const raw=options.storage!.getItem(journalKey(kind)),value:unknown=raw===null?null:JSON.parse(raw);
            if(!record(value)||value.version!==1||value.requestKey!==key||value.jobId!==undefined&&value.jobId!==id)throw Error();
            options.storage!.setItem(journalKey(kind),JSON.stringify({version:1,requestKey:key,jobId:id}));
        });}catch{if(current())publish({storageError:'Принятый UUID задания не сохранён. Новые действия приостановлены; перечитайте квитанцию.'});throw Error('Квитанция принята, но журнал браузера не обновлён.');}
    }
    function apply(job:ProviderJob){publish({jobs:{...state.jobs,[job.kind]:job}});publish({inventory:inventory()});}
    async function run(work:(signal:AbortSignal,current:()=>boolean)=>Promise<void>){
        const owner=options.captureOwner();if(!active||!owner()||state.busy)return;const sequence=epoch,controller=new AbortController();abort=controller;const current=()=>active&&epoch===sequence&&owner();publish({busy:true,error:''});
        try{await work(controller.signal,current);}catch(error){if(current()){
            if([401,403].includes(status(error)??0))publish({jobs:{},inventory:undefined,denied:true});
            publish({error:errorMessage(error,'Локальное состояние не подтверждено. Повторите чтение.')});
        }}finally{if(current()){abort=undefined;publish({busy:false});}}
    }
    async function history(signal:AbortSignal,current:()=>boolean){
        const raw=await options.api.list(signal);if(!Array.isArray(raw))throw Error('История локальных действий не подтверждена.');if(!current())return;
        for(const kind of kinds){const rows=raw.filter(item=>record(item)&&item.deviceId===options.deviceId&&item.kind===kind).map(item=>readProviderJob(item,options.deviceId,kind)).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));if(rows[0])apply(readProviderJob(rows[0],options.deviceId,kind,state.jobs[kind]));}
        publish({denied:false});
    }
    async function recover(kind:GlobalProvidersKind,signal:AbortSignal,current:()=>boolean){
        const requestKey=pending[kind];if(!requestKey)return;
        const request=normalizeGlobalProvidersRequest({deviceId:options.deviceId,kind,scope:'global',requestKey});
        try{
            const raw=await options.api.request(requestKey,signal);if(!current())return;
            if(!record(raw)||raw.requestKey!==requestKey||raw.requestFingerprint!==await globalRequestFingerprint(request,options.role))throw Error('Квитанция не подтверждает исходный запрос и роль.');if(!current())return;
            const job=readProviderJob(raw.job,options.deviceId,kind,state.jobs[kind]);if(accepted[kind]&&accepted[kind]!==job.id)throw Error('Квитанция изменила UUID принятого задания.');await rememberAccepted(kind,requestKey,job.id,current);if(!current())return;confirmed[kind]=true;apply(job);const replayKinds=state.replayKinds.filter(item=>item!==kind);publish({replayKinds,canReplay:!!replayKinds.length});
        }catch(error){if(!current())return;if(status(error)!==404)throw error;const replayKinds=accepted[kind]?state.replayKinds.filter(item=>item!==kind):[...new Set([...state.replayKinds,kind])];publish({replayKinds,canReplay:!!replayKinds.length,error:accepted[kind]?'Принятое задание пока не подтверждено. UUID сохранён; повтор открытия запрещён. Перечитайте квитанцию.':'Сервер пока не подтвердил исходный запрос. Проверьте его или повторите тот же UUID; новое действие не отправляется.'});}
    }
    async function dispatch(kind:GlobalProvidersKind,signal:AbortSignal,current:()=>boolean){
        const requestKey=pending[kind];if(!requestKey||!current()||!(kind===READ?options.canRead():options.canOpen()))return;
        const request=normalizeGlobalProvidersRequest({deviceId:options.deviceId,kind,scope:'global',requestKey});
        try{const job=readProviderJob(await options.api.create(request,signal),options.deviceId,kind);if(current())await rememberAccepted(kind,requestKey,job.id,current);}catch(error){if([401,403].includes(status(error)??0)||state.storageError)throw error;}
        if(current())await recover(kind,signal,current);
    }
    const refresh=()=>run(async(signal,current)=>{
        for(const kind of kinds)try{load(kind);}catch(error){publish({storageError:errorMessage(error,'Журнал не прочитан.')});}
        await history(signal,current);for(const kind of kinds)if(current()&&pending[kind])await recover(kind,signal,current);
    });
    return{
        get state(){return state;},journalKey,
        activate(){active=true;epoch++;state=initial();options.onChange(state);},dispose(){active=false;epoch++;abort?.abort();},refresh,
        start:(kind:GlobalProvidersKind)=>run(async(signal,current)=>{
            if(state.denied||state.storageError||!(kind===READ?options.canRead():options.canOpen())||!options.lock)return;
            try{load(kind);}catch(error){publish({storageError:errorMessage(error,'Журнал не прочитан.')});return;}
            if(pending[kind]&&(!confirmed[kind]||!terminal(state.jobs[kind]))){await recover(kind,signal,current);return;}
            await history(signal,current);if(!current())return;if(kinds.some(key=>state.jobs[key]&&!terminal(state.jobs[key])))throw Error('Дождитесь завершения локального действия или отмените его.');
            const saved=await options.lock(journalKey(kind),()=>{
                if(!current()||!(kind===READ?options.canRead():options.canOpen()))return false;
                const before=options.storage!.getItem(journalKey(kind));load(kind);
                if(pending[kind]&&(!confirmed[kind]||!terminal(state.jobs[kind])))return false;
                const key=options.requestKey?.()??crypto.randomUUID();if(!uuid(key))throw Error('Не удалось создать UUID запроса.');
                if(options.storage!.getItem(journalKey(kind))!==before)throw Error('Журнал изменён другой вкладкой.');
                options.storage!.setItem(journalKey(kind),JSON.stringify({version:1,requestKey:key}));pending[kind]=key;accepted[kind]=undefined;confirmed[kind]=false;
                if(kind===OPEN)publish({inventory:undefined});return true;
            });if(current()){if(saved)await dispatch(kind,signal,current);else await recover(kind,signal,current);}
        }),
        replay:(kind:GlobalProvidersKind)=>run(async(signal,current)=>{if(!state.denied&&!state.storageError&&!accepted[kind]&&state.replayKinds.includes(kind))await dispatch(kind,signal,current);}),
        cancel:(kind:GlobalProvidersKind)=>run(async(signal,current)=>{const job=state.jobs[kind];if(!job||terminal(job)||!options.canRead())return;await options.api.cancel(job.id,signal);if(current()){if(pending[kind])await recover(kind,signal,current);else await history(signal,current);}}),
        storageChanged(){if(!active||!options.captureOwner()())return;epoch++;abort?.abort();publish({busy:false,inventory:undefined,storageError:'Отправка изменена другой вкладкой. Перечитайте состояние.'});},
    };
}
