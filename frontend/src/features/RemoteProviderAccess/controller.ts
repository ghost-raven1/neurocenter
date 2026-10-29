import {errorMessage} from '../../common/utils/errorMessage';
import type {PersonalProviderApi} from './api';
import {personalProviderIntent,type PersonalProviderIntent,type PersonalProviderReceipt,type PersonalProviderView} from './model';
export interface PersonalAccessState {view?:PersonalProviderView;secret:string;pending?:PersonalProviderIntent;receipt?:PersonalProviderReceipt;busy:boolean;error:string;journalError:string;notice:string;canRebase:boolean;}
export const initialPersonalAccess=():PersonalAccessState=>({secret:'',busy:false,error:'',journalError:'',notice:'',canRebase:false});
interface Options {modelId:string;api:PersonalProviderApi;storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>;journal:string;uuid:()=>string;captureOwner:()=>()=>boolean;enabled:()=>boolean;onChange:(state:PersonalAccessState)=>void;}
const status=(error:unknown)=>(error as {response?:{status?:number}}|null)?.response?.status;
/** Only operation identity is durable. Secrets remain inside this owned in-memory draft. */
export function createPersonalAccessController(options:Options){
    let state=initialPersonalAccess(),active=false,epoch=0,request:AbortController|undefined,journalKey:string|undefined;
    const emit=(change:Partial<PersonalAccessState>)=>{state={...state,...change};options.onChange(state);};
    const owned=()=>{const at=epoch,owns=options.captureOwner();return()=>active&&epoch===at&&owns();};
    const readJournal=()=>{
        const raw=options.storage.getItem(options.journal);return raw===null?undefined:personalProviderIntent(JSON.parse(raw));
    };
    const read=async()=>{
        const owns=owned();if(!owns()||request)return;const abort=new AbortController();request=abort;emit({busy:true,error:''});
        try{const view=await options.api.read(options.modelId,abort.signal);if(owns())emit({view});}
        catch(error){if(owns()){if([401,403,404].includes(status(error)??0))emit({view:undefined});emit({error:errorMessage(error,'Не удалось прочитать личный доступ. Ввод сохранён.')});}}
        finally{if(request===abort)request=undefined;if(owns())emit({busy:false});}
    };
    const accept=(value:PersonalProviderReceipt,intent:PersonalProviderIntent,fromPost:boolean)=>{
        if(value.modelId!==options.modelId||value.providerId!==intent.providerId||value.requestKey!==intent.requestKey
            ||value.connectionRevision!==intent.expectedConnectionRevision||value.credentialRevision!==intent.expectedCredentialRevision+1
            ||value.hasKey!==(intent.action==='save'))throw Error('Квитанция относится к другой операции. Прежний ключ повтора сохранён.');
        const saved=readJournal();if(saved?.requestKey!==intent.requestKey)throw Error('Журнал изменился в другой вкладке. Обновите сведения перед новой настройкой.');
        options.storage.removeItem(options.journal);journalKey=undefined;
        emit({pending:undefined,receipt:value,canRebase:false,error:'',...(fromPost?{secret:''}:{}),notice:intent.action==='save'
            ?'Предыдущее сохранение личного ключа подтверждено.'+(!fromPost&&state.secret?' Ввод в поле сохранён; новая настройка не отправлялась.':'')
            :'Удаление личного ключа подтверждено.'});
    };
    const recover=async(conflict=false)=>{
        const owns=owned(),intent=state.pending;if(!owns()||request||!intent)return;
        const abort=new AbortController();request=abort;emit({busy:true});
        let confirmed=false;
        try{
            const receipt=await options.api.receipt(options.modelId,intent.requestKey,abort.signal);
            if(!owns())return;
            if(receipt){accept(receipt,intent,false);confirmed=true;}
            else {
                const advanced=state.view&&(state.view.connectionRevision!==intent.expectedConnectionRevision||state.view.credentialRevision!==intent.expectedCredentialRevision);
                emit({notice:advanced?'Подключение или личный ключ уже изменились. Можно явно перейти к актуальным настройкам.':'Квитанция пока не найдена. Это не доказывает отказ: разрешён повтор с прежним ключом.',canRebase:conflict||!!advanced});
            }
        }catch(error){if(owns())emit({error:errorMessage(error,'Не удалось проверить квитанцию. Ключ повтора сохранён.')});}
        finally{if(request===abort)request=undefined;if(owns())emit({busy:false});}
        if(owns()&&(confirmed||conflict))await read();
    };
    const write=async(action:'save'|'delete')=>{
        const owns=owned();if(!owns()||request||!options.enabled()||!state.view||state.journalError)return;
        const pending=state.pending;
        if(pending&&pending.action!==action)return;
        if(action==='save'&&(!state.secret||state.secret.length>8192||/[\x00-\x20\x7f]/.test(state.secret))){emit({error:'Введите непустой API-ключ без пробелов.'});return;}
        let intent:PersonalProviderIntent;
        try{
            intent=pending??personalProviderIntent({version:1,action,providerId:state.view.providerId,expectedConnectionRevision:state.view.connectionRevision,
                expectedCredentialRevision:state.view.credentialRevision,requestKey:options.uuid()});
            if(!pending){const saved=readJournal();if(saved?.requestKey!==journalKey)throw Error('Журнал изменился в другой вкладке. Проверьте прежнюю настройку.');options.storage.setItem(options.journal,JSON.stringify(intent));journalKey=intent.requestKey;}
        }catch(error){emit({error:errorMessage(error,'Не удалось сохранить ключ повтора. Настройка не отправлена.')});return;}
        const abort=new AbortController();request=abort;emit({pending:intent,busy:true,error:'',notice:'',canRebase:false});
        let failed:unknown,success=false;
        try{const receipt=await options.api.write(options.modelId,intent,state.secret,abort.signal);if(owns()){accept(receipt,intent,true);success=true;}}
        catch(error){failed=error;if(owns())emit({error:errorMessage(error,'Ответ настройки не получен. Проверяем прежнюю квитанцию; ввод сохранён.')});}
        finally{if(request===abort)request=undefined;if(owns())emit({busy:false});}
        if(!owns())return;if(success)await read();else await recover(status(failed)===409);
    };
    return{
        activate:()=>{
            active=true;epoch++;state=initialPersonalAccess();
            try{const pending=readJournal();journalKey=pending?.requestKey;emit({pending});}catch{emit({journalError:'Журнал личного доступа повреждён. Данные сохранены; новая настройка приостановлена.'});}
            const owns=owned();void read().then(()=>{if(owns()&&state.pending)void recover();});
        },
        dispose:()=>{active=false;epoch++;request?.abort();request=undefined;},read,recover:()=>recover(),save:()=>write('save'),remove:()=>write('delete'),
        setSecret:(secret:string)=>{if(!state.busy)emit({secret});},
        rebase:()=>{
            if(!state.canRebase||state.busy||!options.enabled())return;
            try{if(readJournal()?.requestKey!==state.pending?.requestKey)throw Error('Журнал изменился в другой вкладке.');options.storage.removeItem(options.journal);journalKey=undefined;
                emit({pending:undefined,canRebase:false,notice:'Следующее сохранение использует актуальные настройки.',error:''});
            }catch(error){emit({error:errorMessage(error,'Не удалось подтвердить переход. Прежний ключ повтора сохранён.')});}
        },
    };
}
