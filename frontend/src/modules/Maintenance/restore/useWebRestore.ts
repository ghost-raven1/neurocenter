import {useCallback,useEffect,useRef,useState} from 'react';
import {useAuthRequestOwner} from '../../../features/UserBlock/useAuthRequestOwner';
import {errorMessage} from '../../../common/utils/errorMessage';
import {webRestoreApi} from './api';
import {clearRestoreIntent,readRestoreIntent,saveRestoreIntent} from './restoreDraftStore';
import {restoreTerminal,type RestoreIntent,type RestoreJob,type RestorePreview,type RestorePreviewInput,type RestoreStatus} from './types';
const statusCode=(error:unknown)=>(error as {response?:{status?:number}})?.response?.status;
interface RestoreFlight {current:()=>boolean}
/** Durable exact intent сохраняется ДО POST; неизвестный ответ блокирует новую форму до read/retry. */
export function useWebRestore(account:string){
 const {captureOwner}=useAuthRequestOwner(),[status,setStatus]=useState<RestoreStatus>(),[job,setJob]=useState<RestoreJob>(),[intent,setIntent]=useState<RestoreIntent>();
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[blocked,setBlocked]=useState(false),[missing,setMissing]=useState(false);
 const contextRef=useRef({account,captureOwner});
 if(contextRef.current.account!==account||contextRef.current.captureOwner!==captureOwner)contextRef.current={account,captureOwner};
 const context=contextRef.current,viewContext=useRef(context),lock=useRef<RestoreFlight>(),currentIntent=useRef<RestoreIntent>(),readGeneration=useRef(0);
 // StrictMode can invalidate a pending flight without unmounting refs. Only its exact owner may keep or release the lock.
 const acquire=()=>{const owns=captureOwner(),current=()=>contextRef.current===context&&owns();if(!current()||lock.current?.current())return;const flight={current};lock.current=flight;return flight;};
 const release=(flight:RestoreFlight,done:()=>void)=>{if(lock.current!==flight)return;lock.current=undefined;if(flight.current())done();};
 const remember=(value:RestoreIntent|undefined)=>{currentIntent.current=value;setIntent(value);};
 const refresh=useCallback(async()=>{
  const flight=acquire();if(!flight)return;const current=flight.current,generation=++readGeneration.current;setLoading(true);setError('');
  if(viewContext.current!==context){viewContext.current=context;remember(undefined);setStatus(undefined);setJob(undefined);setBusy(false);setMissing(false);setBlocked(false);}
  try{
   const saved=await readRestoreIntent(account);if(!current()||generation!==readGeneration.current)return;remember(saved);setJob(undefined);setMissing(false);setBlocked(false);
   if(saved){try{const found=await webRestoreApi.request(saved.input.requestKey);if(!current()||generation!==readGeneration.current)return;setJob(found);}catch(cause){if(!current())return;if(statusCode(cause)===404)setMissing(true);else{setBlocked(true);throw cause;}}}
   const latest=await webRestoreApi.status();if(current()&&generation===readGeneration.current)setStatus(latest);
  }catch(cause){if(current()){setBlocked(true);setError(errorMessage(cause,'Состояние восстановления не подтверждено. Обновите сведения перед новой попыткой.'));}}
  finally{release(flight,()=>setLoading(false));}
 },[account,captureOwner]);
 useEffect(()=>{void refresh();},[refresh]);
 useEffect(()=>{
  if(!intent||currentIntent.current?.input.requestKey!==intent.input.requestKey||restoreTerminal(job))return;
  const timer=setInterval(()=>{if(lock.current?.current())return;const owns=captureOwner(),current=()=>contextRef.current===context&&owns(),key=intent.input.requestKey;void webRestoreApi.request(key).then(found=>{if(current()&&currentIntent.current?.input.requestKey===key){setJob(found);setMissing(false);setBlocked(false);setError('');}}).catch(cause=>{if(current()&&currentIntent.current?.input.requestKey===key){if(statusCode(cause)===404)setMissing(true);else setError(errorMessage(cause,'Ответ пока неизвестен. Сохранённый запрос не потерян.'));}});},2000);
  return()=>clearInterval(timer);
 },[intent,job,captureOwner]);
 const submit=async(next:RestoreIntent,expectedKey?:string)=>{
  if(blocked)return;const flight=acquire();if(!flight)return;const current=flight.current;setBusy(true);setError('');let saved=false,sent=false;
  try{
   await saveRestoreIntent(account,next,expectedKey);saved=true;
   if(!current())return;
   remember(next);setJob(undefined);setMissing(false);sent=true;const found=await webRestoreApi.submit(next);
   if(current()&&currentIntent.current?.input.requestKey===next.input.requestKey){setJob(found);setBlocked(false);}
  }catch(cause){if(current()){if(!saved)setBlocked(true);setError(errorMessage(cause,sent?'Ответ неизвестен. Обновите состояние или повторите сохранённый запрос; новое подтверждение не создаётся.':'Подтверждение не сохранено. Запрос не отправлен.'));}}
  finally{release(flight,()=>setBusy(false));}
 };
 const check=(selection:Omit<RestorePreviewInput,'requestKey'>)=>submit({kind:'preview',input:{...selection,requestKey:crypto.randomUUID()}});
 const confirm=(preview:RestorePreview,confirmation:string)=>{
  if(!intent||job?.state!=='ready'||job.preview?.digest!==preview.digest||confirmation!=='RESTORE '+preview.targetProject||Date.parse(preview.expiresAt)<=Date.now())return Promise.resolve();
  return submit({kind:'restore',input:{requestKey:crypto.randomUUID(),previewId:job.id,digest:preview.digest,confirmation}},intent.input.requestKey);
 };
 const repeat=()=>{const saved=currentIntent.current;return saved?submit(saved,saved.input.requestKey):Promise.resolve();};
 const newCheck=async()=>{
  if(!intent||!restoreTerminal(job)&&!missing)return;const flight=acquire();if(!flight)return;const current=flight.current;setBusy(true);
  try{if(missing){await webRestoreApi.cancelRequest(intent.input.requestKey);if(!current())return;}const cleared=await clearRestoreIntent(account,intent.input.requestKey);if(!current())return;if(!cleared){setBlocked(true);throw new Error('В другой вкладке уже сохранён другой запрос. Обновите сведения.');}remember(undefined);setJob(undefined);setMissing(false);setBlocked(false);setError('');}
  catch(cause){if(current())setError(errorMessage(cause,'Не удалось освободить форму. Сохранённый запрос остаётся доступным.'));}
  finally{release(flight,()=>setBusy(false));}
 };
 const cancel=async()=>{
  if(job?.state!=='queued')return;const flight=acquire();if(!flight)return;const current=flight.current;setBusy(true);
  try{const found=await webRestoreApi.cancel(job.id);if(current())setJob(found);}catch(cause){if(current())setError(errorMessage(cause,'Результат отмены неизвестен. Обновите состояние запроса.'));}
  finally{release(flight,()=>setBusy(false));}
 };
 return {...(viewContext.current===context?{status,job,intent,busy,loading,error,blocked,missing}:{status:undefined,job:undefined,intent:undefined,busy:false,loading:true,error:'',blocked:false,missing:false}),refresh,check,confirm,repeat,newCheck,cancel};
}
