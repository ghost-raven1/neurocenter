import { Alert, Button, Card, Checkbox, Empty, Input, List, Modal, Space, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { baseApi, bffApi } from '../../core/api';
import { PageHeading } from '../../common/components/PageHeading';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { ArchiveAssetButton } from '../AssetManagement/ArchiveAssetButton';
import { useAssetImports } from './useAssetImports';
import type { ISourceAsset, ISourceList } from './types';
import { activeImport } from './types';
import StoreEditModal from '../../modules/Store/StoreEditModal';
import { fromPlugin, fromSkill } from '../../modules/Store/storeHelpers';
import type { IStoreApp } from '../../modules/Store/AppCard';
import { ModelEditModal } from '../ModelCatalog/ModelEditModal';
import type { ICatalogModel } from '../ModelCatalog/types';
import { AgentEditModal } from '../AgentCatalog/AgentEditModal';
import { agentCatalogApi } from '../AgentCatalog/api';
import type { ICatalogAgent } from '../AgentCatalog/types';
import {LocalAssetCards} from './LocalAssetCards';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import './AssetSources.less';

const labels={mcp:'MCP',plugin:'Плагин',skill:'Скилл',model:'Модель',bridge:'Мост компьютера',agent:'Агент OpenCode'};
/** Главный администратор явно выбирает состав общего каталога; обычное добавление занимает один клик. */
export default function AssetSources():JSX.Element {
 const {scope,captureOwner}=useAuthRequestOwner(),[data,setData]=useState<ISourceList>(),[error,setError]=useState(''),[loading,setLoading]=useState(false),[selected,setSelected]=useState<string[]>([]),[query,setQuery]=useState('');
 const [edit,setEdit]=useState<IStoreApp|null>(null),[model,setModel]=useState<ICatalogModel>(),[editing,setEditing]=useState(''),[resolving,setResolving]=useState(false);
 const [agent,setAgent]=useState<ICatalogAgent>();
 const editRequest=useRef<object>();
 const loadRequest=useRef(0);
 const load=useCallback(async(refresh=false):Promise<void>=>{
  const owns=captureOwner(),request=++loadRequest.current,current=()=>owns()&&loadRequest.current===request;setLoading(true);setError('');
  try{const response=refresh?await baseApi.post<ISourceList>('/api/asset-sources/refresh'):await baseApi.get<ISourceList>('/api/asset-sources');if(current()){setData(response.data);setSelected(previous=>previous.filter(id=>response.data.assets.some(asset=>asset.id===id)));}}
  catch(cause){if(current()){setError(errorMessage(cause,'Не удалось обновить список ассетов. Последний сохранённый список доступен.'));}}
  finally{if(current()){setLoading(false);}}
 },[captureOwner]);
 const imports=useAssetImports(()=>void load());
 useEffect(()=>{editRequest.current=undefined;setEditing('');setResolving(false);setData(undefined);setSelected([]);setEdit(null);setModel(undefined);setAgent(undefined);setQuery('');void load();return()=>{loadRequest.current++;};},[scope,load]);
 useSectionUpdates(['catalog','access'],()=>void load());
 /** Single-flight prevents a late card lookup from replacing another editor's unsaved prompt. */
 const editAsset=async(asset:ISourceAsset):Promise<void>=>{
  if(!asset.imported||asset.kind==='bridge'||editRequest.current){return;}const owns=captureOwner();if(!owns()){return;}const request={};editRequest.current=request;setEditing(asset.id);setError('');
  const current=()=>owns()&&editRequest.current===request;
  try{if(asset.kind==='model'){const {data}=await baseApi.get<ICatalogModel>('/api/models/'+encodeURIComponent(asset.imported.id));if(current()){setModel(data);}}
   else if(asset.kind==='agent'){const card=await agentCatalogApi.get(asset.imported.id);if(current()){setAgent(card);}}
   else{const app=asset.kind==='skill'?fromSkill(await bffApi.getSkill(asset.imported.id)):fromPlugin(await bffApi.getAiPlugin(asset.imported.id));if(current()){setEdit(app);}}
  }catch(cause){if(current()){setError(errorMessage(cause,'Не удалось открыть текущую карточку.'));}}finally{if(editRequest.current===request){editRequest.current=undefined;if(owns()){setEditing('');}}}
 };
 const matches=(asset:ISourceAsset):boolean=>(asset.name+' '+(asset.imported?.name??'')+' '+asset.description+' '+labels[asset.kind]).toLowerCase().includes(query.trim().toLowerCase());
 const cards=(data?.assets??[]).filter(matches),localCards=(data?.localAssets??[]).filter(matches);
 const editControls=(asset:ISourceAsset):JSX.Element|null=>asset.imported&&asset.kind!=='bridge'?<><Button loading={editing===asset.id} disabled={!!editing||imports.blocked||asset.imported.archived||asset.imported.unavailable} onClick={()=>void editAsset(asset)}>Редактировать</Button><ArchiveAssetButton kind={asset.kind} id={asset.imported.id} restore={asset.imported.archived} children={asset.imported.archived?'Вернуть из архива':'Удалить'} onArchived={()=>void load()} disabled={imports.blocked||asset.imported.unavailable}/></>:null;
 const add=(ids:string[]):void=>{if(data?.source.commit){void imports.start(ids,data.source.commit);}};
 const offline=data?.source.mode==='offline';
 return <section className="asset-sources"><PageHeading title="Ассеты" description="Выберите инструменты, модели и агентов для общего каталога. Мост готовит установку компьютеров; состав каталога выбираете вы."
  actions={<Space wrap><Button loading={loading} disabled={imports.blocked} onClick={()=>void load()}>Обновить список</Button><Button loading={loading} disabled={imports.blocked} onClick={()=>void load(true)}>{offline?'Перечитать поставку':'Обновить источник'}</Button></Space>}/>
  <Space direction="vertical" size="middle" className="asset-sources__content">
   {error&&<Alert type="error" showIcon message={error}/>}
   {offline&&<Alert type="info" showIcon message="Автономная поставка" description="Описи и файлы читаются из локальной поставки, закреплённой точным commit. Новые ассеты появятся после загрузки обновлённой поставки на сервер. GitHub не запрашивается."/>}
   {data?.source.error&&<Alert type="warning" showIcon message={data.source.error} description="Показана последняя проверенная опись. Она закреплена точным commit; обновление не меняет уже добавленные карточки."/>}
   <Typography.Text type="secondary">{offline?(data?.source.verified?'Локальная поставка · '+data.source.commit?.slice(0,8):'Локальная поставка ещё не проверена. Нажмите «Перечитать поставку».'):data?.source.verified?'Проверено '+new Date(data.source.checkedAt!).toLocaleString('ru-RU')+' · '+data.source.commit?.slice(0,8):'Источник ещё не проверен. Нажмите «Обновить источник» — скачиваются только небольшие описи.'}</Typography.Text>
   {imports.error&&<Alert type="error" showIcon message={imports.error} action={imports.intent&&!imports.job?<Button loading={imports.busy} onClick={()=>void imports.repeat()}>Повторить запрос</Button>:undefined}/>}
   {imports.job&&<Card size="small" title="Добавление в каталог"><Space direction="vertical" className="asset-sources__content">
    <Typography.Text role="status">{imports.job.message}</Typography.Text>
    <List size="small" dataSource={imports.job.items} renderItem={item=><List.Item><div><Typography.Text>{item.name} · {item.version}</Typography.Text>{!item.current&&<Tag>Точная зависимость</Tag>}<div><Typography.Text type={item.state==='FAILED'||item.action==='conflict'?'danger':'secondary'}>{item.reason||item.message||item.state}</Typography.Text></div></div></List.Item>}/>
    <Space wrap>{activeImport(imports.job.state)?<Button loading={imports.busy} onClick={()=>void imports.cancel()}>Остановить импорт</Button>:<>
     {imports.job.state==='NEEDS_INPUT'&&imports.job.items.some(item=>item.replacement)&&<Button onClick={()=>setResolving(true)}>Решить конфликт</Button>}
     {['FAILED','PARTIAL','NEEDS_INPUT'].includes(imports.job.state)&&<Button loading={imports.busy} onClick={()=>void imports.retry()}>{imports.job.state==='NEEDS_INPUT'&&imports.job.items.some(item=>item.action==='conflict')?'Проверить конфликт заново':'Повторить после исправления'}</Button>}
     <Button onClick={imports.clear}>Новый выбор</Button></>}</Space>
   </Space></Card>}
   <Space wrap><Input.Search aria-label="Поиск ассетов" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Название или назначение" allowClear/>
    <Button type="primary" disabled={!selected.length||!data?.source.verified||imports.blocked} loading={imports.busy} onClick={()=>add(selected)}>Добавить выбранные{selected.length?' ('+selected.length+')':''}</Button></Space>
   <LocalAssetCards assets={localCards} actions={editControls}/>
   {!!data?.localAssets?.length&&<Typography.Title level={3}>Из репозитория ассетов</Typography.Title>}
   {loading&&!data?<Spin/>:cards.length?<div className="asset-sources__grid">{cards.map(asset=><Card key={asset.id} size="small" className="asset-sources__card"
    title={<Space align="start"><Checkbox aria-label={'Выбрать '+asset.name} disabled={imports.blocked} checked={selected.includes(asset.id)} onChange={e=>setSelected(previous=>e.target.checked?[...previous,asset.id]:previous.filter(id=>id!==asset.id))}/><span>{asset.name}</span></Space>}>
    <Space direction="vertical" className="asset-sources__content"><Space wrap><Tag>{labels[asset.kind]}</Tag><Typography.Text type="secondary">{asset.version} · {asset.license}</Typography.Text></Space>
     <Typography.Paragraph>{asset.description||'Описание не добавлено в источник.'}</Typography.Paragraph>
     {!!asset.dependencies.length&&<Typography.Text type="secondary">Включает точные зависимости: {asset.dependencies.map(dep=>dep.id+' '+dep.version).join(', ')}</Typography.Text>}
     {asset.imported&&<Typography.Text type="secondary">В каталоге: версия источника {asset.imported.originVersion}{asset.imported.archived?' · в архиве':asset.imported.updateAvailable?' · доступно обновление':''}</Typography.Text>}
     <Space wrap><Button type="primary" disabled={imports.blocked||!data?.source.verified||asset.imported?.archived||asset.imported?.unavailable} onClick={()=>add([asset.id])}>{asset.imported?(asset.imported.updateAvailable?'Обновить':'Проверить и добавить'):'Добавить'}</Button>
      {editControls(asset)}
     </Space>
    </Space>
   </Card>)}</div>:!localCards.length?<Empty description={data?.source.verified?'По выбранному запросу ассетов нет.':offline?'Перечитайте локальную поставку, чтобы выбрать ассеты.':'Обновите источник, чтобы выбрать ассеты.'}/>:null}
  </Space>
  <Modal open={resolving} title="Заменить локальные карточки источником?" onCancel={()=>{if(!imports.busy){setResolving(false);}}} confirmLoading={imports.busy} okText="Заменить содержимое" cancelText="Оставить локальные"
   okButtonProps={{danger:true,disabled:!imports.job?.items.filter(item=>item.action==='conflict').every(item=>!!item.replacement)}} onOk={()=>{void imports.resolve().then(()=>setResolving(false));}}>
   <Typography.Paragraph>Содержимое выбранных локальных карточек будет заменено точной версией источника. Прежние версии, файлы и закреплённые версии проектов сохранятся.</Typography.Paragraph>
   <List dataSource={imports.job?.items.filter(item=>item.action==='conflict')} renderItem={item=><List.Item><div><Typography.Text strong>{item.name}</Typography.Text><div>Локальная версия: {item.replacement?.version??'замена недоступна'} → источник {item.version}</div><Typography.Text type="secondary">{item.reason}</Typography.Text></div></List.Item>}/>
  </Modal>
  <StoreEditModal key={scope} editApp={edit} onClose={()=>setEdit(null)} onSaved={()=>void load()}/>
  {model&&<ModelEditModal key={model.id+':'+scope} model={model} onClose={()=>setModel(undefined)} onSaved={()=>load()}/>}
  {agent&&<AgentEditModal key={agent.id+':'+agent.version+':'+scope} agent={agent} onClose={()=>setAgent(undefined)} onSaved={()=>load()}/>}
 </section>;
}
