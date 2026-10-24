import {useCallback,useEffect,useRef,useState} from 'react';
import {bridgeApi,type IBridgeJob} from '../McpBridge/api';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {errorMessage} from '../../common/utils/errorMessage';
import {clearLearningBridgeIntent,learningBridgeActive,learningBridgeActor,learningBridgeFingerprint,learningBridgeScope,readLearningBridgeIntent,requireLearningBridgeInput,requireLearningBridgeReceipt,saveLearningBridgeIntent,type LearningBridgeInput,type LearningBridgeIntent,type LearningBridgeKind} from './learningBridgeIntent';

interface Props{projectId:string;kind:LearningBridgeKind;canSend:(input:LearningBridgeInput)=>boolean;create:(input:LearningBridgeInput)=>Promise<IBridgeJob>;reload:()=>Promise<unknown>}
interface Flight{current:()=>boolean}
/** One durable original intent fences both learning bridge operations across close, remount and late ACKs. */
export function useLearningBridgeIntent(props:Props){
 const {scope,captureOwner}=useAuthRequestOwner(),key=learningBridgeScope(scope,props.projectId,props.kind),identity=JSON.stringify([scope,key]),actorRole=learningBridgeActor(scope).role;
 const contextRef=useRef({identity});if(contextRef.current.identity!==identity)contextRef.current={identity};const context=contextRef.current;
 const latest=useRef(props);latest.current=props;
 const life=useRef({active:false}),lock=useRef<Flight>(),pending=useRef<LearningBridgeIntent>(),view=useRef(context),status=useRef({missing:false,blocked:false});
 const [intent,setIntent]=useState<LearningBridgeIntent>(),[job,setJob]=useState<IBridgeJob>(),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[missing,setMissing]=useState(false),[blocked,setBlocked]=useState(false);
 const missingState=(value:boolean)=>{status.current.missing=value;setMissing(value);},blockedState=(value:boolean)=>{status.current.blocked=value;setBlocked(value);};
 const acquire=()=>{const owns=captureOwner(),lifetime=life.current,current=()=>lifetime.active&&life.current===lifetime&&contextRef.current===context&&owns();if(!current()||lock.current?.current())return;const flight={current};lock.current=flight;return flight;};
 const release=(flight:Flight)=>{if(lock.current!==flight)return;lock.current=undefined;if(flight.current()){setBusy(false);setLoading(false);}};
 const remember=(value:LearningBridgeIntent|undefined)=>{pending.current=value;setIntent(value);};
 const accept=(value:Awaited<ReturnType<typeof bridgeApi.request>>,saved:LearningBridgeIntent,current:()=>boolean)=>{
  if(!current()||JSON.stringify(pending.current)!==JSON.stringify(saved))return;
  const stored=readLearningBridgeIntent(key,saved.input.projectId,saved.input.kind);
  if(stored&&JSON.stringify(stored)!==JSON.stringify(saved))throw new Error('Сохранённый запрос изменился. Сначала проверьте отправку.');
  const found=requireLearningBridgeReceipt(value,saved);setJob(found);missingState(false);blockedState(false);
  if(!learningBridgeActive(found)){clearLearningBridgeIntent(key,saved);remember(undefined);}
 };
 const check=useCallback(async()=>{
  const flight=acquire();if(!flight)return;setBusy(true);setError('');
  try{
   const saved=readLearningBridgeIntent(key,props.projectId,props.kind);if(!flight.current())return;remember(saved);blockedState(false);missingState(false);
   if(saved){
    if(await learningBridgeFingerprint(saved.input,saved.actorRole)!==saved.requestFingerprint)throw new Error('Сохранённый запрос изменился. Новая отправка заблокирована.');
    if(flight.current())accept(await bridgeApi.request(saved.input.requestKey),saved,flight.current);
   }
  }catch(cause){if(flight.current()){if((cause as {response?:{status?:number}})?.response?.status===404){missingState(true);setError('Исходный запрос пока не найден. Можно проверить снова или явно отправить сохранённый запрос.');}else{blockedState(true);setError(errorMessage(cause,'Не удалось проверить исходный запрос.'));}}}
  finally{release(flight);}
 },[key,identity,captureOwner,props.projectId,props.kind]);
 useEffect(()=>{
  life.current={active:true};view.current=context;remember(undefined);setJob(undefined);setBusy(false);setLoading(true);missingState(false);blockedState(false);setError('');
  void check();const lifetime=life.current;return()=>{lifetime.active=false;};
 },[check]);
 const send=async(input:LearningBridgeInput,repeat=false)=>{
  if(input.projectId!==props.projectId||input.kind!==props.kind||!latest.current.canSend(input)||view.current!==context)return;
  const flight=acquire();if(!flight)return;setBusy(true);setError('');
  let posting=false,sent:LearningBridgeIntent|undefined;
  try{
   const stored=readLearningBridgeIntent(key,props.projectId,props.kind);
   if(repeat){
    if(!stored||!status.current.missing||status.current.blocked||stored.actorRole!==actorRole)return;
    if(JSON.stringify(pending.current)!==JSON.stringify(stored))throw new Error('Сохранённый запрос изменился. Сначала проверьте отправку.');
    input=stored.input;
   }
   else if(stored||pending.current||status.current.blocked)return;
   input=requireLearningBridgeInput(JSON.parse(JSON.stringify(input)),props.projectId,props.kind);
   const requestFingerprint=await learningBridgeFingerprint(input,actorRole);if(!flight.current())return;
   const saved=saveLearningBridgeIntent(key,{actorRole,requestFingerprint,input});remember(saved);missingState(false);
   if(!flight.current()||!latest.current.canSend(saved.input))return;
   sent=saved;posting=true;await latest.current.create(saved.input);posting=false;if(!flight.current())return;
   accept(await bridgeApi.request(saved.input.requestKey),saved,flight.current);
   if(flight.current())void latest.current.reload().catch(()=>{if(flight.current())setError('Задание принято. Обновите состояние отправки.');});
  }catch(cause){if(flight.current()){
   const statusCode=(cause as {response?:{status?:number}})?.response?.status;
   if(!repeat&&posting&&sent&&[400,403,409].includes(statusCode??0)){
    try{clearLearningBridgeIntent(key,sent);remember(undefined);missingState(false);blockedState(false);}
    catch(cleanup){blockedState(true);setError(errorMessage(cleanup,'Не удалось освободить исходный запрос.'));return;}
   }else if(!pending.current||!posting&&statusCode!==404)blockedState(true);
   if(!posting&&pending.current&&statusCode===404)missingState(true);
   setError(errorMessage(cause,'Отправка не подтверждена. Проверьте исходный запрос.'));
  }}
  finally{release(flight);}
 };
 const repeat=()=>{const saved=pending.current;return saved?send(saved.input,true):Promise.resolve();};
 const cancel=async(id:string,canManage:boolean)=>{
  if(!canManage)return;const flight=acquire();if(!flight)return;setBusy(true);setError('');
  try{await bridgeApi.cancel(id);if(flight.current())await latest.current.reload();}
  catch(cause){if(flight.current())setError(errorMessage(cause,'Не удалось остановить задание. Проверьте состояние.'));}
  finally{release(flight);}
 };
 useEffect(()=>{
  if(!intent)return;const timer=window.setInterval(()=>{if(document.visibilityState!=='hidden')void check();},2500);
  return()=>window.clearInterval(timer);
 },[intent?.input.requestKey,check]);
 const visible=view.current===context;
 return {intent:visible?intent?.input:undefined,submitted:visible?job:undefined,busy:visible&&busy,loading:!visible||loading,error:visible?error:'',missing:visible&&missing,blocked:visible&&blocked,roleChanged:visible&&!!intent&&intent.actorRole!==actorRole,send,repeat,check,cancel};
}
