import { isAxiosError } from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { baseApi } from '../../core/api';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { activeImport, readImportIntent, type IAssetImport, type IImportIntent } from './types';

/** Reload читает состояние; неизвестный исход всегда сохраняет прежний ключ, даже после последующего 4xx. */
export function useAssetImports(onComplete:()=>void) {
 const {scope,captureOwner}=useAuthRequestOwner(),key='asset-import:'+encodeURIComponent(scope);
 const [intent,setIntent]=useState<IImportIntent>(),[job,setJob]=useState<IAssetImport>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [stateScope,setStateScope]=useState(scope),loadedScope=useRef(scope);
 const pending=useRef<symbol>(),currentIntent=useRef<IImportIntent>(),currentJob=useRef<IAssetImport>(),refresh=useRef(onComplete);refresh.current=onComplete;
 const save=useCallback((value:IImportIntent|undefined,requireStorage=false):boolean=>{
  let persisted=true;try{if(value){localStorage.setItem(key,JSON.stringify(value));}else{localStorage.removeItem(key);}}catch{persisted=false;}
  if(persisted||!requireStorage){currentIntent.current=value;setIntent(value);}return persisted;
 },[key]);
 const showJob=useCallback((value:IAssetImport|undefined):void=>{
  // A poll started before the cancellation ACK cannot undo the accepted stop request.
  const previous=currentJob.current;
  // These durable terminal states have no retry/resolve transition for the same job.
  if(value&&previous?.id===value.id&&['SUCCEEDED','CANCELLED'].includes(previous.state)&&value.state!==previous.state){return;}
  const next=value&&previous?.id===value.id&&previous.cancelRequested&&activeImport(value.state)?{...value,cancelRequested:true}:value;
  currentJob.current=next;setJob(next);
 },[]);
 const beginRequest=useCallback(()=>{
  const owns=captureOwner();if(!owns()||loadedScope.current!==scope||pending.current){return;}
  const token=Symbol();pending.current=token;setBusy(true);setError('');
  return {owns:()=>owns()&&pending.current===token,finish:()=>{
   if(pending.current===token){pending.current=undefined;if(owns()){setBusy(false);}}
  }};
 },[scope,captureOwner]);
 const lookup=useCallback(async(saved:IImportIntent):Promise<void>=>{
  const request=beginRequest();if(!request){return;}
  try{const {data}=await baseApi.get<IAssetImport>(saved.jobId?'/api/asset-imports/'+saved.jobId:'/api/asset-imports/by-request/'+saved.requestKey);
   if(request.owns()){showJob(data);save({...saved,rejected:undefined,jobId:data.id});if(!activeImport(data.state)){refresh.current();}}
  }catch(cause){if(request.owns()){setError(errorMessage(cause,'Не удалось восстановить состояние импорта. Повторите проверку или сохранённый запрос.'));}}
  finally{request.finish();}
 },[beginRequest,save,showJob]);
 useEffect(()=>{
  loadedScope.current=scope;setStateScope(scope);showJob(undefined);setError('');setBusy(false);pending.current=undefined;
  let saved:IImportIntent|undefined;try{saved=readImportIntent(localStorage.getItem(key));}catch{/* Браузер запретил storage. */}
  currentIntent.current=saved;setIntent(saved);
  if(saved?.rejected){setError('Запрос импорта отклонён.');}
  else if(saved){void lookup(saved);}
  return()=>{pending.current=undefined;};
 },[scope,key,lookup,showJob]);
 useEffect(()=>{
  if(!job||!activeImport(job.state)){return;}const owns=captureOwner();let timer:ReturnType<typeof setTimeout>|undefined,closed=false;
  const poll=async():Promise<void>=>{
   try{const {data}=await baseApi.get<IAssetImport>('/api/asset-imports/'+job.id);if(!owns()||closed){return;}showJob(data);setError('');if(!activeImport(data.state)){refresh.current();return;}}
   catch(cause){if(owns()&&!closed){setError(errorMessage(cause,'Связь прервалась. Импорт продолжается на сервере; проверяем состояние.'));}}
   if(owns()&&!closed){timer=setTimeout(()=>void poll(),1500);}
  };timer=setTimeout(()=>void poll(),1000);return()=>{closed=true;if(timer){clearTimeout(timer);}};
 },[job?.id,job?.state,captureOwner,showJob]);
 const submit=async(saved:IImportIntent,fresh=false):Promise<void>=>{
  const request=beginRequest();if(!request){return;}
  const submitted:IImportIntent={requestKey:saved.requestKey,commit:saved.commit,ids:saved.ids};
  // До отправки снимаем прежнее подтверждение отказа: reload во время POST должен считать исход неизвестным.
  if(!save(submitted,true)){setError('Браузер не сохранил запрос. Запрос не отправлен. Проверьте место и разрешение на хранение данных сайта.');request.finish();return;}
  showJob(undefined);
  try{const {data}=await baseApi.post<IAssetImport>('/api/asset-imports',submitted);
   if(request.owns()){save({...submitted,jobId:data.id});showJob(data);if(!activeImport(data.state)){refresh.current();}}
  }catch(cause){if(request.owns()){
   if((fresh||saved.rejected)&&isAxiosError(cause)&&[400,403,409].includes(cause.response?.status??0)){save({...submitted,rejected:true});}
   setError(errorMessage(cause,'Сервер не подтвердил приём запроса. Повтор сохранит тот же ключ.'));
  }}finally{request.finish();}
 };
 const start=(ids:string[],commit:string):Promise<void>=>{
  if(currentJob.current&&activeImport(currentJob.current.state)){return Promise.resolve();}
  const previous=currentIntent.current;
  if(previous&&!currentJob.current){return submit(previous);}
  return submit({ids,commit,requestKey:crypto.randomUUID()},true);
 };
 const action=async(type:'retry'|'cancel'|'resolve'):Promise<void>=>{
  const target=currentJob.current;if(!target){return;}const request=beginRequest();if(!request){return;}
  try{const {data}=await baseApi.post<IAssetImport>('/api/asset-imports/'+target.id+'/'+type,type==='resolve'?{expectedDigest:target.planDigest}:undefined);if(request.owns()){showJob(data);}}
  catch(cause){if(request.owns()){setError(errorMessage(cause,'Не удалось изменить импорт. Сохранённый результат не потерян.'));}}
  finally{request.finish();}
 };
 const owned=stateScope===scope,canReset=owned&&!busy&&!job&&intent?.rejected===true;
 return {job:owned?job:undefined,intent:owned?intent:undefined,busy:owned?busy:false,error:owned?error:'',canReset,start,
  repeat:()=>currentIntent.current?submit(currentIntent.current):Promise.resolve(),
  recheck:()=>currentIntent.current?lookup(currentIntent.current):Promise.resolve(),
  retry:()=>action('retry'),resolve:()=>action('resolve'),cancel:()=>action('cancel'),
  blocked:!owned||busy||!!job&&activeImport(job.state)||!!intent&&!job,
  clear:()=>{
   if(!captureOwner()()||loadedScope.current!==scope||pending.current){return;}
   const target=currentJob.current;
   if(target?!activeImport(target.state):!currentIntent.current||currentIntent.current.rejected){save(undefined);showJob(undefined);setError('');}
  }};
}
