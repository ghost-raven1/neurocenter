import { Button, Alert, Modal, Radio, Space, Typography } from 'antd';
import type { ButtonProps } from 'antd';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { baseApi } from '../../core/api';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';

export type TManagedAssetKind='mcp'|'plugin'|'skill'|'model'|'agent';
interface IImpact {impactId:string;digest:string;target:{kind:TManagedAssetKind;id:string;name:string;version:number;archived:boolean};projects:Array<{id:string;name:string}>;preserved:string[];removeBlockers?:Array<{id:string;name:string}>}
interface IProps {kind:TManagedAssetKind;id:string;onArchived?:()=>void;children?:ReactNode;disabled?:boolean;restore?:boolean;buttonProps?:Pick<ButtonProps,'type'|'icon'|'size'|'aria-label'>}
const errorText=(error:unknown):string=>(error as {response?:{data?:{message?:string}}})?.response?.data?.message||'Сервер не подтвердил действие. Повторите тот же запрос.';
/** Удаление всегда показывает конкретные project refs и отправляет digest того же impact. */
export function ArchiveAssetButton({kind,id,onArchived,children='Удалить',disabled,buttonProps,restore=false}:IProps):JSX.Element {
 const {scope,captureOwner}=useAuthRequestOwner(),[impact,setImpact]=useState<IImpact>(),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{setOpen(false);setImpact(undefined);setBusy(false);setError('');},[scope]);
 const [mode,setMode]=useState<'catalog-only'|'catalog-and-projects'>('catalog-only');
 const preview=async():Promise<void>=>{const owns=captureOwner();if(!owns()){return;}setOpen(true);setBusy(true);setError('');setImpact(undefined);setMode('catalog-only');
  try{const {data}=await baseApi.post<IImpact>('/api/asset-management/impact',{kind,id});if(owns()){setImpact(data);}}catch(e){if(owns()){setError(errorText(e));}}finally{if(owns()){setBusy(false);}}};
 const archive=async():Promise<void>=>{if(!impact){return;}const owns=captureOwner();if(!owns()){return;}setBusy(true);setError('');
  try{const {data}=await baseApi.post<{state:string;message:string}>('/api/asset-management/archive',{impactId:impact.impactId,expectedDigest:impact.digest,mode:restore?'restore':mode});
   if(!owns()){return;}if(data.state!=='SUCCEEDED'){setError(data.message);return;}setOpen(false);onArchived?.();
  }catch(e){if(owns()){setError(errorText(e));}}finally{if(owns()){setBusy(false);}}};
 return <><Button {...buttonProps} danger disabled={disabled} loading={busy&&!open} onClick={()=>void preview()}>{children}</Button><Modal open={open} title={impact?(restore?'Вернуть «':'Удалить «')+impact.target.name+'»?':'Проверяем карточку'} onCancel={()=>{if(!busy){setOpen(false);}}} closable={!busy} maskClosable={!busy}
  footer={<Space><Button disabled={busy} onClick={()=>setOpen(false)}>Отмена</Button><Button danger type="primary" loading={busy} disabled={!impact} onClick={()=>void archive()}>{restore?'Вернуть в каталог':'Убрать из каталога'}</Button></Space>}>
  {error&&<Alert type="error" showIcon message={error} action={!impact?<Button onClick={()=>void preview()}>Повторить проверку</Button>:undefined}/>}
  {impact&&<><Typography.Paragraph>{restore?'Карточка снова станет доступна для выбора в общем каталоге.':'Карточка будет архивирована.'} История версий, файлы и установленные на компьютерах инструменты сохранятся.</Typography.Paragraph>
   {kind==='agent'&&!restore&&<Typography.Paragraph type="secondary">При удалении из проектов агенты будут отключены в сохранённых настройках. Их управляемые файлы OpenCode удалятся после применения через мост в каждой связанной папке. Недоступные компьютеры сохранят прежние файлы до подключения.</Typography.Paragraph>}
   {impact.projects.length>0?<><Typography.Paragraph>Карточка подключена к проектам: {impact.projects.map(project=>project.name).join(', ')}.</Typography.Paragraph>
    {!restore&&<Radio.Group value={mode} onChange={e=>setMode(e.target.value)}><Space direction="vertical"><Radio value="catalog-only">Сохранить подключения проектов</Radio><Radio value="catalog-and-projects" disabled={!!impact.removeBlockers?.length}>Также убрать из {impact.projects.length} проектов</Radio></Space></Radio.Group>}</>:<Typography.Text type="secondary">Подключений к проектам нет.</Typography.Text>}
   {!restore&&!!impact.removeBlockers?.length&&<Alert type="warning" showIcon message="Нельзя убрать активную модель из проектов"
    description={<>Эта модель выбрана для базы знаний проектов: {impact.removeBlockers.map(project=>project.name).join(', ')}. Сначала выберите другую модель в настройках базы знаний этих проектов, затем обновите проверку.</>}
    action={<Button disabled={busy} onClick={()=>void preview()}>Обновить проверку</Button>}/>}</>}
 </Modal></>;
}
