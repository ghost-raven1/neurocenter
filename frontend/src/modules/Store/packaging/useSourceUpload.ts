import {useEffect,useRef,useState} from 'react';
import {isAxiosError} from 'axios';
import {errorMessage} from '../../../common/utils/errorMessage';
import {sourceUploadApi} from './sourceUploadApi';
import {clearUploadIntent,readUploadIntent,saveUploadIntent} from './uploadDraftStore';
import {sourceUploadLimit,type SourceUpload,type SourceUploadIntent,type UploadedSource} from './uploadTypes';

type Phase='idle'|'hashing'|'creating'|'uploading'|'ready'|'recovering'|'cancelling';
interface View {scope:string;upload?:SourceUpload;intent?:SourceUploadIntent;phase:Phase;percent:number;error:string;blocked?:boolean}
/** Hashing failure happens before an upload intent; the raw File is never persisted as JSON or IndexedDB. */
export async function hashSourceUpload(file:Pick<File,'name'|'size'|'arrayBuffer'>):Promise<Omit<SourceUploadIntent,'requestKey'>>{
 if(!Number.isSafeInteger(file.size)||file.size<1||file.size>sourceUploadLimit)throw new Error('Выберите непустой готовый архив или исполняемый файл до 256 МиБ.');
 if(!file.name||file.name.length>240||/[\\/\x00-\x1f\x7f]/.test(file.name))throw new Error('У файла должно быть переносимое имя без папок.');
 if(!globalThis.crypto?.subtle)throw new Error('Проверка SHA-256 недоступна. Откройте сайт по HTTPS или localhost.');
 let bytes:ArrayBuffer|undefined;
 try{bytes=await file.arrayBuffer();if(bytes.byteLength!==file.size)throw new Error();const digest=await crypto.subtle.digest('SHA-256',bytes);return {name:file.name,bytes:file.size,sha256:[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')};}
 catch{throw new Error('Не удалось прочитать и проверить файл. Загрузка ещё не создана. Выберите файл повторно.');}
 finally{bytes=undefined;}
}

/** Actor/scope epochs fence hashing, durable writes, raw transfers, lookup and cancellation across A → B → A. */
export function useSourceUpload(scope:string,captureOwner:()=>()=>boolean){
 const [recoveryAttempt,setRecoveryAttempt]=useState(0);
 const [view,setView]=useState<View>({scope,phase:'recovering',percent:0,error:''});
 const recovery=useRef<Promise<void>>(Promise.resolve()),restoring=useRef<UploadedSource>(),restoreAttempt=useRef('');
 const writes=useRef(new Set<{scope:string;promise:Promise<SourceUploadIntent>}>());
 const sequence=useRef(0),renderScope=useRef(scope),mounted=useRef(true),busy=useRef(false),saved=useRef<SourceUploadIntent>(),currentUpload=useRef<SourceUpload>(),loaded=useRef(''),controller=useRef<AbortController>();
 if(renderScope.current!==scope){renderScope.current=scope;sequence.current++;}
 const publish=(next:Partial<View>)=>setView(previous=>({...previous,...next,scope}));
 useEffect(()=>{
  mounted.current=true;const request=++sequence.current,owns=captureOwner(),abort=new AbortController();controller.current?.abort();controller.current=abort;
  busy.current=false;saved.current=undefined;currentUpload.current=undefined;restoring.current=undefined;restoreAttempt.current='';loaded.current='';setView({scope,phase:'recovering',percent:0,error:''});
  const current=()=>mounted.current&&sequence.current===request&&renderScope.current===scope&&owns();
  const task=readUploadIntent(scope).then(async intent=>{
   if(!current())return;saved.current=intent;loaded.current=scope;
   if(!intent){publish({phase:'idle'});return;}publish({intent});
   try{const upload=await sourceUploadApi.lookup(intent.requestKey,abort.signal);if(current()){currentUpload.current=upload;publish({upload,phase:upload.state==='READY'?'ready':'idle',percent:upload.state==='READY'?100:0,error:upload.state==='READY'?'':'Выберите тот же файл, чтобы продолжить загрузку, или отмените её.'});}}
   catch(cause){if(current())publish({phase:'idle',error:isAxiosError(cause)&&cause.response?.status===404?'Выберите тот же файл, чтобы отправить сохранённую загрузку.':errorMessage(cause,'Не удалось проверить сохранённую загрузку. Повторите проверку.')});}
  }).catch(cause=>{if(current())publish({phase:'idle',blocked:true,error:errorMessage(cause,'Не удалось восстановить загрузку. Файл не отправлен.')});});
  recovery.current=task;
  return()=>{mounted.current=false;sequence.current++;abort.abort();controller.current?.abort();};
 },[scope,captureOwner,recoveryAttempt]);
 const begin=()=>{
  const request=++sequence.current,owns=captureOwner(),abort=new AbortController();controller.current?.abort();controller.current=abort;
  return {abort,current:()=>mounted.current&&sequence.current===request&&renderScope.current===scope&&owns()};
 };
 const select=async(file:File)=>{
  if(busy.current||loaded.current!==scope||view.blocked)return;
  const operation=begin();if(!operation.current())return;busy.current=true;publish({phase:'hashing',error:'',percent:0});
  try{
   const checked=await hashSourceUpload(file);if(!operation.current())return;
   const previous=saved.current;
   if(previous&&(previous.sha256!==checked.sha256||previous.bytes!==checked.bytes||previous.name!==checked.name))throw new Error('Сначала отмените сохранённую загрузку. Другой файл не отправится под её UUID.');
   const intent=previous??{...checked,requestKey:crypto.randomUUID()};
   const writing={scope,promise:saveUploadIntent(scope,intent)};writes.current.add(writing);
   let retained:SourceUploadIntent;try{retained=await writing.promise;}catch(cause){if(operation.current())publish({blocked:true});throw cause;}finally{writes.current.delete(writing);}
   if(!operation.current())return;saved.current=retained;publish({intent:retained,phase:'creating'});
   const upload=await sourceUploadApi.create(retained,operation.abort.signal);if(!operation.current())return;currentUpload.current=upload;publish({upload});
   if(upload.state==='CANCELLED')throw new Error('Эта загрузка отменена. Очистите её перед выбором нового файла.');
   if(upload.state==='READY'){publish({upload,phase:'ready',percent:100});return;}
   publish({phase:'uploading'});
   const completed=await sourceUploadApi.content(upload.id,file,operation.abort.signal,percent=>{if(operation.current())publish({percent});});
   if(operation.current()){currentUpload.current=completed;publish({upload:completed,phase:completed.state==='READY'?'ready':'idle',percent:completed.state==='READY'?100:0});}
  }catch(cause){if(operation.current())publish({phase:'idle',error:errorMessage(cause,'Передача прервана. Проверьте сохранённую загрузку и повторите тот же файл.')});}
  finally{if(operation.current())busy.current=false;}
 };
 const recheck=async()=>{
  if(busy.current)return;if(!saved.current){if(restoring.current)await restore(restoring.current,true);return;}const operation=begin();if(!operation.current())return;busy.current=true;publish({phase:'recovering',error:''});
  try{const upload=await sourceUploadApi.lookup(saved.current.requestKey,operation.abort.signal);if(operation.current()){currentUpload.current=upload;publish({upload,phase:upload.state==='READY'?'ready':'idle',percent:upload.state==='READY'?100:0});}}
  catch(cause){if(operation.current())publish({phase:'idle',error:errorMessage(cause,'Не удалось проверить загрузку. Новый запрос не создан.')});}
  finally{if(operation.current())busy.current=false;}
 };
 const cancel=async()=>{
  const pending=[...writes.current].filter(write=>write.scope===scope),operation=begin();let intent=saved.current;if(!operation.current())return;busy.current=true;publish({phase:'cancelling',error:''});
  try{
   // An IndexedDB transaction may commit after aborting its former UI owner. Cancel that exact committed UUID first.
   const completed=await Promise.allSettled(pending.map(write=>write.promise));if(!operation.current())return;
   for(const result of completed)if(result.status==='fulfilled')intent=result.value;
   if(!intent&&completed.some(result=>result.status==='rejected'))throw new Error('Не удалось проверить сохранение загрузки. Повторите отмену.');
   if(intent){saved.current=intent;publish({intent});await sourceUploadApi.cancel(intent.requestKey,operation.abort.signal);if(!operation.current())return;}
   if(!await clearUploadIntent(scope,intent?.requestKey)){if(operation.current())publish({blocked:true});throw new Error('В другом окне уже выбрана другая загрузка. Повторите восстановление.');}if(operation.current()){saved.current=undefined;currentUpload.current=undefined;publish({intent:undefined,upload:undefined,phase:'idle',percent:0});}}
  catch(cause){if(operation.current())publish({phase:'idle',error:errorMessage(cause,'Результат отмены неизвестен. Повторите отмену того же запроса.')});}
  finally{if(operation.current())busy.current=false;}
 };
 const forget=async()=>{
  const operation=begin(),intent=saved.current;if(!operation.current())return false;
  try{if(!await clearUploadIntent(scope,intent?.requestKey)){if(operation.current())publish({blocked:true});throw new Error('В другом окне уже выбрана другая загрузка. Повторите восстановление.');}if(operation.current()){saved.current=undefined;currentUpload.current=undefined;restoring.current=undefined;restoreAttempt.current='';loaded.current=scope;busy.current=false;publish({intent:undefined,upload:undefined,phase:'idle',percent:0,error:'',blocked:false});return true;}}
  catch(cause){if(operation.current())publish({error:errorMessage(cause,'Не удалось очистить сохранённую загрузку.')});}return false;
 };
 const restore=async(source:UploadedSource,force=false)=>{
  const owns=captureOwner();await recovery.current;if(!mounted.current||renderScope.current!==scope||!owns())return;
  const key=source.uploadId+':'+source.sha256;restoring.current=source;
  if(busy.current||!force&&(currentUpload.current?.id===source.uploadId||restoreAttempt.current===key))return;restoreAttempt.current=key;const operation=begin();if(!operation.current())return;busy.current=true;publish({phase:'recovering',error:''});
  try{const upload=await sourceUploadApi.get(source.uploadId,operation.abort.signal);if(upload.sha256!==source.sha256||upload.bytes!==source.bytes||upload.state!=='READY')throw new Error('Сохранённые байты загрузки не подтверждены. Повторите проверку сборки.');if(!operation.current())return;currentUpload.current=upload;publish({upload,phase:'ready',percent:100});}
  catch(cause){if(operation.current())publish({phase:'idle',error:errorMessage(cause,'Не удалось восстановить исходный архив сборки.')});}
  finally{if(operation.current())busy.current=false;}
 };
 const visible=view.scope===scope;
 return {...(visible?view:{scope,phase:'recovering' as const,percent:0,error:''}),busy:!visible||['hashing','creating','uploading','recovering','cancelling'].includes(view.phase),select,recheck,cancel,forget,restore,retryRecovery:()=>setRecoveryAttempt(value=>value+1)};
}
