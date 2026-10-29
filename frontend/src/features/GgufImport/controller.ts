import type {ICatalogModel} from '../ModelCatalog/types';
import {errorMessage} from '../../common/utils/errorMessage';
import type {GgufImportApi} from './api';
import type {GgufJournal} from './journal';
import {acceptance,readImportedModel,readPolicy,readReceipt,validateFile,type GgufImportAccept,type GgufImportPolicy,type GgufImportReceipt} from './model';

type Phase='idle'|'reading'|'creating'|'uploading'|'accepting'|'cancelling';
export interface GgufImportState {
    key:string|null;receipt?:GgufImportReceipt;file?:File;policy?:Readonly<GgufImportPolicy>;model?:ICatalogModel;
    phase:Phase;loaded:number;error:string;limitsError:string;journalError:string;missing:boolean;notified:boolean;
    name:string;description:string;capability:'chat'|'embedding';acceptLocked:boolean;
}
export const initialGgufImport=():GgufImportState=>({key:null,phase:'idle',loaded:0,error:'',limitsError:'',journalError:'',missing:false,notified:false,name:'',description:'',capability:'chat',acceptLocked:false});
interface Dependencies {
    api:GgufImportApi;journal:GgufJournal;uuid:()=>string;enabled:()=>boolean;canWrite:()=>boolean;
    captureOwner:()=>()=>boolean;onChange:(value:GgufImportState)=>void;onImported:(model:ICatalogModel)=>void|Promise<void>;
}
const status=(error:unknown)=>(error as {response?:{status?:number}})?.response?.status;

/** The journal survives ACK loss; live requests and File objects belong to one current auth scope. */
export function createGgufImportController(deps:Dependencies){
    let state=initialGgufImport(),active=false,version=0,nameEdited=false,request:AbortController|undefined,acceptIntent:GgufImportAccept|undefined,lastReceipt:GgufImportReceipt|undefined;
    const replace=(next:GgufImportState)=>{state=next;deps.onChange({...state});};
    const update=(next:Partial<GgufImportState>)=>replace({...state,...next});
    const ready=()=>active&&deps.captureOwner()()&&deps.canWrite();
    const assertJournal=()=>{if(deps.journal.read()!==state.key)throw Error('Импорт изменился в другой вкладке. Обновите страницу и проверьте состояние.');};
    const newWork=()=>{if(!deps.enabled())throw Error('Новые действия импорта выключены. Проверка состояния и отмена доступны.');};
    async function perform(phase:Phase,work:(current:()=>boolean,signal:AbortSignal)=>Promise<void>,replace=false,clearError=true){
        if(!ready()||state.journalError||request&&!replace)return;
        request?.abort();const controller=new AbortController(),ticket=++version,owns=deps.captureOwner();request=controller;
        const current=()=>active&&ticket===version&&owns()&&!controller.signal.aborted;
        update({phase,...(clearError?{error:''}:{})});
        try{await work(current,controller.signal);}
        catch(error){if(current())update({error:errorMessage(error,'Результат не подтверждён. Проверьте состояние импорта; номер запроса и введённые данные сохранены.')});}
        finally{if(ticket===version){request=undefined;if(current())update({phase:'idle'});}}
    }
    const applyReceipt=(receipt:GgufImportReceipt)=>{lastReceipt=receipt;update({receipt,missing:false,
        ...(!nameEdited&&!state.name?{name:receipt.fileName.replace(/\.gguf$/i,'').slice(0,128)}:{}),
        ...(receipt.state==='CANCELLED'?{file:undefined,acceptLocked:false}:{}),
    });};
    async function notify(model:ICatalogModel,current:()=>boolean){
        update({model});if(state.notified)return;
        try{await deps.onImported(model);if(current())update({notified:true});}
        catch{if(current())update({error:'Модель сохранена, но каталог не удалось обновить. Повторите обновление каталога.'});}
    }
    async function read(current:()=>boolean,signal:AbortSignal){
        assertJournal();if(!state.key)return;
        let raw:unknown;
        try{raw=await deps.api.lookup(state.key,signal);}catch(error){if(status(error)===404){if(current())update({missing:true,receipt:undefined,model:undefined,notified:false});return;}throw error;}
        if(!current())return;
        const receipt=readReceipt(raw,state.key,lastReceipt);applyReceipt(receipt);
        if(receipt.state==='ACCEPTED'){
            const model=await deps.api.model(receipt.modelId!,signal);
            if(current())await notify(readImportedModel(model,receipt),current);
        }
    }
    const recover=()=>perform('reading',read);
    const refreshLimits=()=>perform('reading',async(current,signal)=>{
        try{const policy=readPolicy(await deps.api.limits(signal));if(current())update({policy,limitsError:''});}
        catch(error){if(current())update({limitsError:errorMessage(error,'Лимиты не подтверждены. Новую загрузку начните после повторной проверки.')});}
    },false,false);
    const upload=()=>perform('creating',async(current,signal)=>{
        newWork();assertJournal();const file=state.file;if(!file)throw Error('Выберите файл GGUF на этом компьютере.');
        if(state.key){await read(current,signal);if(!current())return;}
        let receipt=state.receipt;
        if(receipt&&['READY','ACCEPTED'].includes(receipt.state))return;
        if(receipt?.state==='CANCELLED')throw Error('Импорт отменён. Начните новый импорт.');
        if(!receipt){
            let policy:Readonly<GgufImportPolicy>;
            try{policy=readPolicy(await deps.api.limits(signal));}catch(error){if(current())update({limitsError:errorMessage(error,'Лимиты не подтверждены. Повторите проверку.')});return;}
            if(!current())return;update({policy,limitsError:''});validateFile(file,policy.maximumBytes);newWork();assertJournal();
            const key=state.key??deps.uuid();if(!state.key){deps.journal.write(key,null);update({key});}
            const raw=await deps.api.create({requestKey:key,fileName:file.name,bytes:file.size},signal);
            if(!current())return;receipt=readReceipt(raw,key,lastReceipt);
            if(receipt.fileName!==file.name||receipt.bytes!==file.size)throw Error('Квитанция относится к другому файлу. Проверьте прежний импорт.');
            applyReceipt(receipt);
        }
        if(receipt.state==='READY'||receipt.state==='ACCEPTED'){await read(current,signal);return;}
        validateFile(file,receipt.limits.maximumBytes);
        if(file.name!==receipt.fileName||file.size!==receipt.bytes)throw Error('Для повтора выберите тот же файл: '+receipt.fileName+'.');
        if(!current())return;newWork();assertJournal();update({phase:'uploading',loaded:0});
        const raw=await deps.api.upload(receipt.id,file,signal,loaded=>{if(current()&&Number.isFinite(loaded))update({loaded:Math.min(file.size,Math.max(0,loaded))});});
        if(!current())return;const confirmed=readReceipt(raw,state.key!,lastReceipt??receipt);
        if(!['READY','ACCEPTED'].includes(confirmed.state))throw Error('Передача завершилась без подтверждения проверки файла. Проверьте состояние импорта.');
        applyReceipt(confirmed);if(confirmed.state==='ACCEPTED')await read(current,signal);
    });
    const cancel=()=>perform('cancelling',async(current,signal)=>{
        await read(current,signal);if(!current())return;
        if(!state.receipt)throw Error('Импорт пока не найден. Это не подтверждает отмену: проверьте состояние повторно.');
        if(state.receipt.state==='ACCEPTED')throw Error('Модель уже сохранена. Источник модели остаётся в каталоге.');
        assertJournal();const raw=await deps.api.cancel(state.receipt.id,signal);if(!current())return;
        const receipt=readReceipt(raw,state.key!,lastReceipt);if(receipt.state!=='CANCELLED')throw Error('Отмена не подтверждена. Проверьте состояние.');applyReceipt(receipt);
    },true);
    const accept=()=>perform('accepting',async(current,signal)=>{
        newWork();assertJournal();if(state.receipt?.state!=='READY')throw Error('Сначала дождитесь проверки файла GGUF.');
        const intent=acceptIntent??acceptance(state.name,state.description,state.capability);acceptIntent=intent;update({acceptLocked:true});
        let raw:unknown;
        try{raw=await deps.api.accept(state.receipt.id,intent,signal);}
        catch(error){if(current()&&[400,409].includes(status(error)??0)){acceptIntent=undefined;update({acceptLocked:false});}throw error;}
        if(!current())return;const model=readImportedModel(raw,state.receipt);
        applyReceipt({...state.receipt,state:'ACCEPTED',modelId:model.id});await notify(model,current);
    });
    return {
        activate:()=>{
            active=true;nameEdited=false;acceptIntent=undefined;lastReceipt=undefined;replace(initialGgufImport());
            try{update({key:deps.journal.read()});}catch(error){update({journalError:errorMessage(error,'Не удалось прочитать сохранённый номер импорта. Данные не изменены.')});return;}
            void (async()=>{if(state.key)await recover();if(active)await refreshLimits();})();
        },
        dispose:()=>{active=false;version++;request?.abort();request=undefined;},
        refreshLimits,recover,upload,cancel,accept,
        selectFile:(file:File)=>{
            if(!ready()||request||state.journalError||state.receipt&&['READY','ACCEPTED','CANCELLED'].includes(state.receipt.state))return;
            try{validateFile(file,state.receipt?.limits.maximumBytes??state.policy?.maximumBytes??Number.MAX_SAFE_INTEGER);
                if(state.receipt&&(state.receipt.fileName!==file.name||state.receipt.bytes!==file.size))throw Error('Для продолжения выберите '+state.receipt.fileName+' с тем же размером.');
                update({file,loaded:0,error:'',...(!nameEdited&&!state.name?{name:file.name.replace(/\.gguf$/i,'').slice(0,128)}:{})});
            }catch(error){update({error:errorMessage(error,'Не удалось выбрать GGUF. Прежний файл сохранён.')});}
        },
        change:(field:'name'|'description'|'capability',value:string)=>{
            if(!ready()||request||state.acceptLocked)return;
            if(field==='capability'){if(value==='chat'||value==='embedding')update({capability:value});}else {if(field==='name')nameEdited=true;update({[field]:value});}
        },
        notify:()=>perform('reading',async current=>{if(state.model)await notify(state.model,current);}),
        reset:()=>{
            if(!ready()||request||state.journalError||!state.key||!state.receipt||!['CANCELLED','ACCEPTED'].includes(state.receipt.state))return;
            try{deps.journal.clear(state.key);acceptIntent=undefined;nameEdited=false;lastReceipt=undefined;replace({...initialGgufImport(),policy:state.policy});}catch(error){update({error:errorMessage(error,'Не удалось завершить локальную квитанцию.')});}
        },
    };
}
