import {Alert,Button,Modal,Select,Space,Typography} from 'antd';
import {useEffect,useRef,useState} from 'react';
import {useBridge} from '../McpBridge/useBridge';
import {createBridgeRequestKey} from '../McpBridge/bridgeRequestKey';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {errorMessage} from '../../common/utils/errorMessage';
import type {LearningContext} from '../../../../services/shared/project-learning.cjs';
import {learningMemorySyncApi} from './learningMemorySyncApi';
import {useLearningBridgeIntent} from './useLearningBridgeIntent';
import {learningBridgeActive} from './learningBridgeIntent';
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
 const [source,setSource]=useState<LearningContext>(),[selected,setSelected]=useState(''),[sourceError,setSourceError]=useState(''),[reload,setReload]=useState(0);
 const identity=JSON.stringify([scope,projectId]),sourceOwner=useRef(''),current=useRef({identity,canManage,availability,bridge,selected,source});current.current={identity,canManage,availability,bridge,selected,source};
 const action=useLearningBridgeIntent({projectId,kind:'sync-learning-memory',reload:bridge.reload,
  canSend:input=>current.current.canManage&&input.kind==='sync-learning-memory'&&(input.memoryMode==='cleanup'||current.current.availability.enabled),
  create:input=>{if(input.kind!=='sync-learning-memory')throw new Error('Неверный исходный запрос.');return learningMemorySyncApi.create(input);}});
 useEffect(()=>{setSelected('');},[identity]);
 useEffect(()=>{const input=action.intent;if(input)setSelected(JSON.stringify([input.deviceId,input.assetId,input.expectedManifest]));},[action.intent]);
 useEffect(()=>{
  const owns=captureOwner(),controller=new AbortController();let active=true;setSource(undefined);setSourceError('');sourceOwner.current='';
  void learningMemorySyncApi.context(projectId,controller.signal).then(value=>{if(active&&owns()){sourceOwner.current=identity;setSource(value);}})
   .catch(cause=>{if(active&&!controller.signal.aborted&&owns())setSourceError(errorMessage(cause,'Не удалось загрузить принятые знания.'));});
  return()=>{active=false;controller.abort();};
 },[identity,reload,captureOwner,projectId]);
 const visibleSource=sourceOwner.current===identity?source:undefined;
 const {targets,blocker}=selection(bridge,projectId,selected,visibleSource,canManage);
 const targetOptions=targets.map(item=>({value:JSON.stringify([item.deviceId,item.assetId,item.manifest]),label:item.name+' · '+(bridge.devices.find(device=>device.id===item.deviceId)?.name||'Компьютер')}));
 const original=action.intent,originalSelection=original?JSON.stringify([original.deviceId,original.assetId,original.expectedManifest]):undefined;
 if(original&&originalSelection&&!targetOptions.some(item=>item.value===originalSelection))targetOptions.push({value:originalSelection,label:'Исходная установка MCP Memory · версия '+original.version+' · '+(bridge.devices.find(device=>device.id===original.deviceId)?.name||'Исходный компьютер')});
 const jobs=bridge.jobs.filter(job=>job.kind==='sync-learning-memory'&&job.projectId===projectId);
 const job=action.submitted||jobs[0],active=learningBridgeActive(job);
 const submit=async(mode:'sync'|'cleanup'):Promise<void>=>{
  const snapshot=current.current;
  if(!captureOwner()()||snapshot.identity!==identity||action.intent||action.loading||action.blocked)return;
  const {target,binding,blocker:latestBlocker}=selection(snapshot.bridge,projectId,snapshot.selected,sourceOwner.current===identity?snapshot.source:undefined,snapshot.canManage);
  if(latestBlocker||!target||!binding?.bindingId||!binding.instanceId||!snapshot.source||mode==='sync'&&!snapshot.availability.enabled
   ||snapshot.bridge.jobs.some(item=>item.kind==='sync-learning-memory'&&item.projectId===projectId&&learningBridgeActive(item)))return;
  await action.send({kind:'sync-learning-memory',deviceId:target.deviceId,projectId,requestKey:createBridgeRequestKey(),assetId:target.assetId,assetKind:'mcp',version:target.version,expectedManifest:target.manifest,expectedBindingId:binding.bindingId,expectedInstanceId:binding.instanceId,expectedLearningRevision:snapshot.source.revision,expectedLearningDigest:snapshot.source.digest,memoryMode:mode});
 };
 const unavailable=!!blocker||active||!!action.intent||action.loading||action.blocked;
 return <Modal open centered title="Принятые знания → MCP Memory" onCancel={onClose} footer={<Button onClick={onClose}>Закрыть</Button>}>
  <Space direction="vertical" className="learning-memory-sync">
   <Typography.Paragraph>Источник: одобренные человеком знания этого проекта. Гипотезы и исходные кварки автоматически не применяются. Личная память и ручные наблюдения сохраняются.</Typography.Paragraph>
   <Typography.Text>Принятых записей: {visibleSource?.entries.length??'…'}. Ревизия: {visibleSource?.revision??'…'}.</Typography.Text>
   <Select aria-label="Установленный Memory и компьютер" placeholder="Выберите установленный MCP Memory" value={originalSelection??(selected||undefined)} disabled={action.busy||!!action.intent||action.loading} onChange={setSelected} options={targetOptions}/>
   {blocker&&<Alert type="info" showIcon message={blocker}/>} {!availability.enabled&&<Alert type="info" showIcon message={availability.reason}/>}
   {(action.error||sourceError)&&<Alert type="error" showIcon role="alert" message={action.error||sourceError}/>}
   <Space wrap><Button type="primary" loading={action.busy} disabled={unavailable||!availability.enabled} onClick={()=>{void submit('sync');}}>Синхронизировать принятые знания</Button>
    <Button disabled={unavailable||action.busy} onClick={()=>{void submit('cleanup');}}>Очистить отозванные записи</Button>
    <Button disabled={action.busy} onClick={()=>{setReload(value=>value+1);void bridge.reload();void action.check();}}>Обновить</Button></Space>
   {action.intent&&<Alert type="warning" showIcon message="Исходный запрос сохранён" description={action.roleChanged?'Для повторной отправки вернитесь к роли исходной отправки. Проверка и история доступны.':'Проверка только читает состояние. До подтверждённого завершения новый запрос недоступен. Исходная установка: '+action.intent.assetId+' · версия '+action.intent.version+'.'}
    action={<Space wrap><Button loading={action.busy} onClick={()=>{void action.check();}}>Проверить отправку</Button>
     {action.missing&&<Button disabled={action.busy||action.blocked||action.roleChanged||!canManage||action.intent.kind==='sync-learning-memory'&&action.intent.memoryMode==='sync'&&!availability.enabled} onClick={()=>{void action.repeat();}}>Отправить исходный запрос</Button>}</Space>}/>}
   {job&&<Alert showIcon type={job.state==='failed'?'warning':'info'} message={job.message} description={job.result?.code==='quota'?'План превышает допустимый объём. Уменьшите объём и повторите; исходный выбор сохранён.':job.result?.status==='partial'?'Сохранён частичный результат. Следующая синхронизация продолжит проверенный план без дублирования.':undefined}
    action={active&&canManage?<Button disabled={action.busy} onClick={()=>{void action.cancel(job.id,current.current.canManage);}}>Отменить</Button>:undefined}/>}
   <Typography.Text type="secondary">Кварки RAG остаются исходным опытом. Memory получает только принадлежащие Нейроцентру записи; отзыв удаляет собственные наблюдения и сохраняет ручные связи.</Typography.Text>
  </Space>
 </Modal>;
}
