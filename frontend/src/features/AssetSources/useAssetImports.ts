import { useCallback, useEffect, useRef, useState } from 'react';
import { baseApi } from '../../core/api';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { activeImport, readImportIntent, type IAssetImport, type IImportIntent } from './types';

/** Reload восстанавливает только GET состояния; повтор POST сохраняет прежний server intent key. */
export function useAssetImports(onComplete:()=>void) {
 const {scope,captureOwner}=useAuthRequestOwner(),key='asset-import:'+encodeURIComponent(scope);
 const [intent,setIntent]=useState<IImportIntent>(),[job,setJob]=useState<IAssetImport>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const pending=useRef(false),currentIntent=useRef<IImportIntent>(),refresh=useRef(onComplete);refresh.current=onComplete;
 const save=useCallback((value:IImportIntent|undefined):void=>{currentIntent.current=value;setIntent(value);try{if(value){localStorage.setItem(key,JSON.stringify(value));}else{localStorage.removeItem(key);}}catch{/* Сессия продолжает работать без persistence браузера. */}},[key]);
 useEffect(()=>{
  setJob(undefined);setError('');setBusy(false);pending.current=false;
  let saved:IImportIntent|undefined;try{saved=readImportIntent(localStorage.getItem(key));}catch{/* Браузер запретил storage. */}
  currentIntent.current=saved;setIntent(saved);
  if(!saved){return;}const owns=captureOwner();
  void baseApi.get<IAssetImport>(saved.jobId?'/api/asset-imports/'+saved.jobId:'/api/asset-imports/by-request/'+saved.requestKey).then(({data})=>{
   if(owns()){setJob(data);save({...saved,jobId:data.id});}
  }).catch(cause=>{if(owns()){setError(errorMessage(cause,'Не удалось восстановить состояние импорта. Повторите сохранённый запрос.'));}});
 },[key,captureOwner,save]);
 useEffect(()=>{
  if(!job||!activeImport(job.state)){return;}const owns=captureOwner();let timer:ReturnType<typeof setTimeout>|undefined,closed=false;
  const poll=async():Promise<void>=>{
   try{const {data}=await baseApi.get<IAssetImport>('/api/asset-imports/'+job.id);if(!owns()||closed){return;}setJob(data);setError('');if(!activeImport(data.state)){refresh.current();return;}}
   catch(cause){if(owns()&&!closed){setError(errorMessage(cause,'Связь прервалась. Импорт продолжается на сервере; проверяем состояние.'));}}
   if(owns()&&!closed){timer=setTimeout(()=>void poll(),1500);}
  };timer=setTimeout(()=>void poll(),1000);return()=>{closed=true;if(timer){clearTimeout(timer);}};
 },[job?.id,job?.state,captureOwner]);
 const submit=async(saved:IImportIntent):Promise<void>=>{
  const owns=captureOwner();if(!owns()||pending.current){return;}pending.current=true;setBusy(true);setError('');save(saved);
  try{const {data}=await baseApi.post<IAssetImport>('/api/asset-imports',{requestKey:saved.requestKey,commit:saved.commit,ids:saved.ids});
   if(owns()){save({...saved,jobId:data.id});setJob(data);if(!activeImport(data.state)){refresh.current();}}
  }catch(cause){if(owns()){setError(errorMessage(cause,'Сервер не подтвердил приём запроса. Повтор сохранит тот же ключ.'));}}
  finally{pending.current=false;if(owns()){setBusy(false);}}
 };
 const start=(ids:string[],commit:string):Promise<void>=>{
  const previous=currentIntent.current;
  if(previous&&!job){return submit(previous);}
  return submit({ids,commit,requestKey:crypto.randomUUID()});
 };
 const action=async(type:'retry'|'cancel'|'resolve'):Promise<void>=>{
  const owns=captureOwner();if(!job||!owns()||pending.current){return;}pending.current=true;setBusy(true);setError('');
  try{const {data}=await baseApi.post<IAssetImport>('/api/asset-imports/'+job.id+'/'+type,type==='resolve'?{expectedDigest:job.planDigest}:undefined);if(owns()){setJob(data);}}
  catch(cause){if(owns()){setError(errorMessage(cause,'Не удалось изменить импорт. Сохранённый результат не потерян.'));}}
  finally{pending.current=false;if(owns()){setBusy(false);}}
 };
 return {job,intent,busy,error,start,repeat:()=>intent?submit(intent):Promise.resolve(),retry:()=>action('retry'),resolve:()=>action('resolve'),cancel:()=>action('cancel'),
  blocked:busy||!!job&&activeImport(job.state)||!!intent&&!job,clear:()=>{if(!pending.current&&(!job||!activeImport(job.state))){save(undefined);setJob(undefined);setError('');}}};
}
