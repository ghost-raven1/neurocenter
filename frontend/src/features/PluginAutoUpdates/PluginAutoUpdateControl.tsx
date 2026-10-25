import {Alert,Button,Modal,Space,Spin,Switch,Typography} from 'antd';
import {useEffect,useRef,useState} from 'react';
import type {IBridgeInstallation} from '../McpBridge/api';
import {bridgeApi} from '../McpBridge/api';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {errorMessage} from '../../common/utils/errorMessage';
import {createBridgeRequestKey} from '../McpBridge/bridgeRequestKey';
import {pluginAutoUpdateApi,type PluginUpdateMutation,type PluginUpdatePolicy} from './api';

interface Props {installation:IBridgeInstallation;canManage:boolean;onChanged:()=>void;}
/** A closed optional control does not load private policy state or expand the installation row. */
export function PluginAutoUpdateControl({installation,canManage,onChanged}:Props):JSX.Element|null {
 const {scope,captureOwner}=useAuthRequestOwner(),availability=useFeatureAvailability('plugin_auto_updates');
 const [open,setOpen]=useState(false),[policy,setPolicy]=useState<PluginUpdatePolicy|null>(),[error,setError]=useState('');
 const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[pending,setPending]=useState<PluginUpdateMutation>();
 const request=useRef<AbortController>(),sequence=useRef(0),mutation=useRef(false);
 const target={deviceId:installation.deviceId,projectId:installation.projectId,bindingId:installation.bindingId??'',assetId:installation.assetId};
 const identity=JSON.stringify([scope,target]),identityRef=useRef(identity);identityRef.current=identity;
 const refresh=async():Promise<void>=>{
  if(mutation.current)return;request.current?.abort();const controller=new AbortController(),epoch=++sequence.current,owner=captureOwner(),key=identity;
  request.current=controller;setLoading(true);setError('');
  try{const next=await pluginAutoUpdateApi.read(target,controller.signal);if(owner()&&identityRef.current===key&&sequence.current===epoch)setPolicy(next);}
  catch(cause){if(owner()&&identityRef.current===key&&sequence.current===epoch&&!controller.signal.aborted)setError(errorMessage(cause,'Не удалось прочитать автообновление.'));}
  finally{if(owner()&&identityRef.current===key&&sequence.current===epoch)setLoading(false);}
 };
 useEffect(()=>{
  request.current?.abort();++sequence.current;mutation.current=false;setBusy(false);setPolicy(undefined);setPending(undefined);setError('');
  if(open)void refresh();
  return()=>{request.current?.abort();++sequence.current;};
 },[open,identity]);
 useEffect(()=>{if(!open||pending)return;const timer=setInterval(()=>{void refresh();},5000);return()=>clearInterval(timer);},[open,identity,pending]);
 if(installation.assetKind!=='plugin'||!installation.bindingId)return null;
 const save=async(input:PluginUpdateMutation):Promise<void>=>{
  if(mutation.current||input.enabled&&(!canManage||!availability.enabled))return;
  request.current?.abort();const controller=new AbortController(),epoch=++sequence.current,owner=captureOwner(),key=identity;
  request.current=controller;mutation.current=true;setBusy(true);setLoading(false);setPending(input);setError('');
  try{const next=await pluginAutoUpdateApi.save(input,controller.signal);if(!owner()||identityRef.current!==key||sequence.current!==epoch)return;
   setPolicy(next);setPending(undefined);changed();
  }catch(cause){if(owner()&&identityRef.current===key&&sequence.current===epoch&&!controller.signal.aborted)setError(errorMessage(cause,'Режим не подтверждён. Ваш выбор сохранён.'));}
  finally{if(identityRef.current===key&&sequence.current===epoch){mutation.current=false;if(owner())setBusy(false);}}
 };
 const changed=():void=>{try{onChanged();}catch{/* A refresh callback cannot turn an accepted mutation into an unknown ACK. */}};
 const cancel=async():Promise<void>=>{
  if(mutation.current||!policy?.job)return;
  request.current?.abort();const epoch=++sequence.current,owner=captureOwner(),key=identity,jobId=policy.job.id;
  mutation.current=true;setBusy(true);setError('');
  try{await bridgeApi.cancel(jobId);if(!owner()||identityRef.current!==key||sequence.current!==epoch)return;
   mutation.current=false;setBusy(false);void refresh();changed();
  }catch(cause){if(owner()&&identityRef.current===key&&sequence.current===epoch)setError(errorMessage(cause,'Не удалось отменить задание.'));}
  finally{if(identityRef.current===key&&sequence.current===epoch){mutation.current=false;if(owner())setBusy(false);}}
 };
 const select=(enabled:boolean):void=>{if(policy===undefined)return;void save({...target,enabled,expectedRevision:policy?.revision??0,requestKey:createBridgeRequestKey()});};
 return <><Button size="small" onClick={()=>setOpen(true)}>Автообновление</Button>
  <Modal title="Автообновление плагина" open={open} onCancel={()=>setOpen(false)} footer={null} destroyOnClose>
   <Space direction="vertical" size="middle" style={{width:'100%'}}>
    <Typography.Text strong>{installation.name} · версия {installation.version}</Typography.Text>
    <Typography.Paragraph>Каждый час проверяем версию, закреплённую и одобренную для этого проекта. Само появление версии в общем каталоге не меняет установку.</Typography.Paragraph>
    <Typography.Paragraph type="secondary">При изменении настроек или зависимостей потребуется ручной план. Локальные изменения проверяет обычный установщик; при отказе прежняя версия сохраняется.</Typography.Paragraph>
    {policy===undefined&&loading?<Spin tip="Читаем режим…"/>:policy!==undefined?<>
     <Space><Switch aria-label="Автоматически устанавливать одобренные версии" checked={policy?.enabled??false} disabled={busy||loading||!policy?.enabled&&(!canManage||!availability.enabled)} onChange={select}/><span>{policy?.enabled?'Включено':'Выключено'}</span></Space>
     {policy&&<Alert role="status" type={policy.status==='attention'?'warning':'info'} showIcon message={policy.message}
      description={<>{policy.checkedAt&&<div>Проверено: {new Date(policy.checkedAt).toLocaleString('ru-RU')}</div>}{policy.job&&<div>Последнее задание: {policy.job.state}. {policy.job.message}</div>}</>}/>}
     {!!policy?.enabled&&<Button disabled={!canManage||!availability.enabled||busy||loading} onClick={()=>select(true)}>Проверить сейчас</Button>}
     {policy?.job?.state==='queued'&&<Button disabled={busy} onClick={()=>{void cancel();}}>Отменить задание</Button>}
    </>:null}
    {!availability.enabled&&<Alert type="info" showIcon message={availability.reason}/>}
    {error&&<Alert role="alert" type="error" showIcon message={error} description={pending?'Ваш выбор: '+(pending.enabled?'включить':'выключить')+'. Запрос сохранён для точного повтора.':undefined}/>}
    {pending&&!busy&&<Space wrap><Button disabled={pending.enabled&&(!canManage||!availability.enabled)} onClick={()=>{void save(pending);}}>Повторить сохранение</Button><Button onClick={()=>{setPending(undefined);void refresh();}}>Использовать актуальный режим</Button></Space>}
    <Button disabled={busy||loading} onClick={()=>{void refresh();}}>Обновить состояние</Button>
    <Typography.Text type="secondary">Выключение останавливает будущие обновления. Принятое задание можно отменить отдельно, история сохраняется.</Typography.Text>
   </Space>
  </Modal></>;
}
