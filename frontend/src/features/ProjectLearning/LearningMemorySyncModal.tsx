import {Alert,Button,Modal,Select,Space,Typography} from 'antd';
import {useEffect,useRef,useState} from 'react';
import {useBridge} from '../McpBridge/useBridge';
import {bridgeApi,type IBridgeJob} from '../McpBridge/api';
import {createBridgeRequestKey} from '../McpBridge/bridgeRequestKey';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {errorMessage} from '../../common/utils/errorMessage';
import type {LearningContext} from '../../../../services/shared/project-learning.cjs';
import {learningMemorySyncApi,type LearningMemoryRequest} from './learningMemorySyncApi';
import './LearningMemorySync.less';

interface Props {projectId:string;canManage:boolean;onClose:()=>void}
function selection(bridge:ReturnType<typeof useBridge>,projectId:string,selected:string,source:LearningContext|undefined,canManage:boolean){
 const targets=bridge.installations.filter(item=>item.projectId===projectId&&item.assetKind==='mcp');
 const target=targets.find(item=>JSON.stringify([item.deviceId,item.assetId,item.manifest])===selected);
 const device=bridge.devices.find(item=>item.id===target?.deviceId),binding=device?.report.bindings?.find(item=>item.projectId===projectId);
 const blocker=!canManage?'Синхронизация требует роли администратора проекта.':!source?'Обновите принятые знания.':!target?'Выберите установленный MCP Memory.':!target.learningMemory?'Обновите MCP Memory из каталога: эта версия не поддерживает синхронизацию.':!target.isCurrentBinding||!binding?.bindingId||!binding.instanceId?'Свяжите текущую папку проекта с компьютером.':!device?.online||!bridge.devicesReady?'Компьютер недоступен. Запустите мост и обновите статус.':!device.report.capabilities?.includes('project-learning-memory-v1')?'Обновите мост на выбранном компьютере.':'';
 return {targets,target,binding,blocker};
}
/** The source is approved project context; local Memory text and personal graphs never enter this UI. */
export function LearningMemorySyncModal({projectId,canManage,onClose}:Props):JSX.Element{
 const bridge=useBridge(),{scope,captureOwner}=useAuthRequestOwner(),availability=useFeatureAvailability('project_learning_memory');
 const [source,setSource]=useState<LearningContext>(),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[reload,setReload]=useState(0),[submitted,setSubmitted]=useState<IBridgeJob>();
 const request=useRef<{identity:string;input:LearningMemoryRequest}>(),lock=useRef(false),generation=useRef(0),live=useRef(true),sourceOwner=useRef(''),submittedOwner=useRef('');
 const identity=JSON.stringify([scope,projectId]),current=useRef({identity,canManage,availability,bridge,selected,source,unknown,submitted});current.current={identity,canManage,availability,bridge,selected,source,unknown,submitted};
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 useEffect(()=>{request.current=undefined;setUnknown(false);setSubmitted(undefined);setSelected('');},[identity]);
 useEffect(()=>{
  const owns=captureOwner(),sequence=++generation.current,controller=new AbortController();setSource(undefined);setError('');sourceOwner.current='';
  void learningMemorySyncApi.context(projectId,controller.signal).then(value=>{if(live.current&&owns()&&sequence===generation.current){sourceOwner.current=identity;setSource(value);}})
   .catch(cause=>{if(!controller.signal.aborted&&owns()&&sequence===generation.current)setError(errorMessage(cause,'Не удалось загрузить принятые знания.'));});
  return()=>{generation.current++;controller.abort();};
 },[identity,reload,captureOwner,projectId]);
 const {targets,blocker}=selection(bridge,projectId,selected,sourceOwner.current===identity?source:undefined,canManage);
 const submit=async(mode:'sync'|'cleanup',replay=false):Promise<void>=>{
  const owns=captureOwner(),snapshot=current.current;
  if(!owns()||lock.current||!snapshot.canManage||snapshot.identity!==identity)return;
  const {target,binding,blocker:latestBlocker}=selection(snapshot.bridge,projectId,snapshot.selected,sourceOwner.current===identity?snapshot.source:undefined,snapshot.canManage);
  if(!replay&&(latestBlocker||snapshot.unknown||mode==='sync'&&!snapshot.availability.enabled
   ||submittedOwner.current===identity&&snapshot.submitted&&['queued','running','reconciling'].includes(snapshot.submitted.state)
   ||snapshot.bridge.jobs.some(job=>job.kind==='sync-learning-memory'&&job.projectId===projectId&&['queued','running','reconciling'].includes(job.state))))return;
  if(!replay){
   if(!target||!binding?.bindingId||!binding.instanceId||!snapshot.source)return;
   request.current={identity,input:{kind:'sync-learning-memory',deviceId:target.deviceId,projectId,requestKey:createBridgeRequestKey(),assetId:target.assetId,assetKind:'mcp',version:target.version,expectedManifest:target.manifest,expectedBindingId:binding.bindingId,expectedInstanceId:binding.instanceId,expectedLearningRevision:snapshot.source.revision,expectedLearningDigest:snapshot.source.digest,memoryMode:mode}};
  }
  if(!request.current||request.current.identity!==identity)return;const input=request.current.input;lock.current=true;setBusy(true);setError('');
  try{const job=await learningMemorySyncApi.create(input);if(!live.current||!owns()||current.current.identity!==identity)return;submittedOwner.current=identity;setSubmitted(job);setUnknown(false);request.current=undefined;void current.current.bridge.reload();}
  catch(cause){if(live.current&&owns()&&current.current.identity===identity){setUnknown(true);setError(errorMessage(cause,'Отправка не подтверждена. Проверьте результат с прежним ключом.'));}}
  finally{lock.current=false;if(live.current&&owns()&&current.current.identity===identity)setBusy(false);}
 };
 const cancel=async(id:string):Promise<void>=>{
  const owns=captureOwner();if(!owns()||!current.current.canManage||current.current.identity!==identity)return;
  try{await bridgeApi.cancel(id);if(live.current&&owns()&&current.current.identity===identity)await current.current.bridge.reload();}
  catch(cause){if(live.current&&owns()&&current.current.identity===identity)setError(errorMessage(cause,'Не удалось отменить задание.'));}
 };
 const jobs=bridge.jobs.filter(job=>job.kind==='sync-learning-memory'&&job.projectId===projectId);
 const visibleSubmitted=submittedOwner.current===identity?submitted:undefined;
 const job=jobs.find(item=>item.id===visibleSubmitted?.id)||visibleSubmitted||jobs[0],active=!!job&&['queued','running','reconciling'].includes(job.state);
 const visibleSource=sourceOwner.current===identity?source:undefined;
 return <Modal open centered title="Принятые знания → MCP Memory" onCancel={onClose} footer={<Button onClick={onClose}>Закрыть</Button>}>
  <Space direction="vertical" className="learning-memory-sync">
   <Typography.Paragraph>Источник: одобренные человеком знания этого проекта. Гипотезы и исходные кварки автоматически не применяются. Личная память и ручные наблюдения сохраняются.</Typography.Paragraph>
   <Typography.Text>Принятых записей: {visibleSource?.entries.length??'…'}. Ревизия: {visibleSource?.revision??'…'}.</Typography.Text>
   <Select aria-label="Установленный Memory и компьютер" placeholder="Выберите установленный MCP Memory" value={selected||undefined} disabled={busy||unknown} onChange={setSelected}
    options={targets.map(item=>({value:JSON.stringify([item.deviceId,item.assetId,item.manifest]),label:item.name+' · '+(bridge.devices.find(device=>device.id===item.deviceId)?.name||item.deviceId)}))}/>
   {blocker&&<Alert type="info" showIcon message={blocker}/>} {!availability.enabled&&<Alert type="info" showIcon message={availability.reason}/>}
   {error&&<Alert type="error" showIcon message={error}/>}
   <Space wrap><Button type="primary" loading={busy} disabled={!!blocker||active||unknown||!availability.enabled} onClick={()=>{void submit('sync');}}>Синхронизировать принятые знания</Button>
    <Button disabled={!!blocker||busy||active||unknown} onClick={()=>{void submit('cleanup');}}>Очистить отозванные записи</Button>
    <Button disabled={busy} onClick={()=>{setReload(value=>value+1);void bridge.reload();}}>Обновить</Button></Space>
   {unknown&&<Alert type="warning" message="Исходный запрос сохранён" description="Проверка повторит тот же ключ. Новый план не создаётся." action={<Button loading={busy} onClick={()=>{void submit(request.current?.input.memoryMode??'sync',true);}}>Проверить отправку</Button>}/>}
   {job&&<Alert showIcon type={job.state==='failed'?'warning':'info'} message={job.message} description={job.result?.code==='quota'?'План превышает допустимый объём. Уменьшите объём и повторите; исходный выбор сохранён.':job.result?.status==='partial'?'Сохранён частичный результат. Следующая синхронизация продолжит проверенный план без дублирования.':undefined}
    action={active&&canManage?<Button onClick={()=>{void cancel(job.id);}}>Отменить</Button>:undefined}/>}
   <Typography.Text type="secondary">Кварки RAG остаются исходным опытом. Memory получает только принадлежащие Нейроцентру записи; отзыв удаляет собственные наблюдения и сохраняет ручные связи.</Typography.Text>
  </Space>
 </Modal>;
}
