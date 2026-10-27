import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { assetCatalogFeature } from '../FeatureFlags/types';
import { Alert, Button, Card, Checkbox, Empty, Input, List, Modal, Space, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { baseApi, bffApi } from '../../core/api';
import { PageHeading } from '../../common/components/PageHeading';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { ArchiveAssetButton } from '../AssetManagement/ArchiveAssetButton';
import { useAssetImports } from './useAssetImports';
import { AssetImportRecovery } from './AssetImportRecovery';
import { AssetCatalogName } from './AssetCatalogName';
import type { ISourceAsset, ISourceList } from './types';
import { activeImport, ASSET_IMPORT_MAX_ITEMS } from './types';
import StoreEditModal from '../Catalog/StoreEditModal';
import { fromPlugin, fromSkill } from '../Catalog/catalogCards';
import type { IStoreApp } from '../Catalog/types';
import { ModelEditModal } from '../ModelCatalog/ModelEditModal';
import type { ICatalogModel } from '../ModelCatalog/types';
import { AgentEditModal } from '../AgentCatalog/AgentEditModal';
import { agentCatalogApi } from '../AgentCatalog/api';
import type { ICatalogAgent } from '../AgentCatalog/types';
import {LocalAssetCards} from './LocalAssetCards';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {formatBytes} from '../../common/utils/format';
import {AssetArchiveModal} from './AssetArchiveModal';
import {AssetArchiveStatus} from './AssetArchiveStatus';
import {useAssetArchiveUpload} from './useAssetArchiveUpload';
import {availableSourceAssetIds,sourceAssetReady} from './archiveUpload';
import './AssetSources.less';

const labels={mcp:'MCP',plugin:'Плагин',skill:'Скилл',model:'Модель',bridge:'Мост компьютера',agent:'Агент OpenCode'};
const itemStates:Record<string,string>={PENDING:'Ожидает очереди',RUNNING:'Обрабатывается',SUCCEEDED:'Готово',FAILED:'Не удалось добавить'};
/** Главный администратор явно выбирает состав общего каталога; обычное добавление занимает один клик. */
export default function AssetSources():JSX.Element {
 const {scope,captureOwner}=useAuthRequestOwner(),[data,setData]=useState<ISourceList>(),[error,setError]=useState(''),[loading,setLoading]=useState(false),[selected,setSelected]=useState<string[]>([]),[query,setQuery]=useState(''),[localQuery,setLocalQuery]=useState('');
 const [edit,setEdit]=useState<IStoreApp|null>(null),[model,setModel]=useState<ICatalogModel>(),[editing,setEditing]=useState(''),[resolving,setResolving]=useState(false);
 const [agent,setAgent]=useState<ICatalogAgent>();
 const [archiveOpen,setArchiveOpen]=useState(false);
 const editRequest=useRef<object>(),catalogAction=useRef<object>();
 const loadRequest=useRef(0),archiveLock=useRef(false),refreshLock=useRef<object>();
 const load=useCallback(async(refresh=false):Promise<void>=>{
  const owns=captureOwner();if(!owns()||archiveLock.current||refreshLock.current)return;const refreshing=refresh?{}:undefined;if(refreshing)refreshLock.current=refreshing;
  const request=++loadRequest.current,current=()=>owns()&&loadRequest.current===request;setLoading(true);setError('');
  try{const response=refresh?await baseApi.post<ISourceList>('/api/asset-sources/refresh'):await baseApi.get<ISourceList>('/api/asset-sources');if(current()){setData(response.data);setSelected(previous=>availableSourceAssetIds(response.data.assets,previous));}}
  catch(cause){if(current()){setError(errorMessage(cause,'Не удалось обновить список ассетов. Последний сохранённый список доступен.'));}}
  finally{if(refreshing&&refreshLock.current===refreshing)refreshLock.current=undefined;if(current()){setLoading(false);}}
 },[captureOwner]);
 const imports=useAssetImports(()=>void load());
 const archiveBlocked=imports.blocked||!!editing||!!edit||!!model||!!agent||resolving||!!refreshLock.current||!!catalogAction.current;
 const archive=useAssetArchiveUpload({blocked:()=>archiveBlocked||!!editRequest.current||!!refreshLock.current||!!catalogAction.current,onStart:()=>{archiveLock.current=true;loadRequest.current++;setLoading(false);setError('');},onFinish:()=>{archiveLock.current=false;},onSuccess:view=>{loadRequest.current++;setData(view);setSelected([]);setLoading(false);setArchiveOpen(false);}});
 useEffect(()=>{editRequest.current=undefined;catalogAction.current=undefined;archiveLock.current=false;refreshLock.current=undefined;setArchiveOpen(false);setEditing('');setResolving(false);setData(undefined);setSelected([]);setEdit(null);setModel(undefined);setAgent(undefined);setQuery('');setLocalQuery('');void load();return()=>{loadRequest.current++;};},[scope,load]);
 useSectionUpdates(['catalog','access'],()=>void load());
 /** Single-flight prevents a late card lookup from replacing another editor's unsaved prompt. */
 const editAsset=async(asset:ISourceAsset):Promise<void>=>{
  if(!asset.imported||asset.kind==='bridge'||editRequest.current||archiveLock.current){return;}const owns=captureOwner();if(!owns()){return;}const request={};editRequest.current=request;setEditing(asset.id);setError('');
  const current=()=>owns()&&editRequest.current===request;
  try{if(asset.kind==='model'){const {data}=await baseApi.get<ICatalogModel>('/api/models/'+encodeURIComponent(asset.imported.id));if(current()){setModel(data);}}
   else if(asset.kind==='agent'){const card=await agentCatalogApi.get(asset.imported.id);if(current()){setAgent(card);}}
   else{const app=asset.kind==='skill'?fromSkill(await bffApi.getSkill(asset.imported.id)):fromPlugin(await bffApi.getAiPlugin(asset.imported.id));if(current()){setEdit(app);}}
  }catch(cause){if(current()){setError(errorMessage(cause,'Не удалось открыть текущую карточку.'));}}finally{if(editRequest.current===request){editRequest.current=undefined;if(owns()){setEditing('');}}}
 };
 const matches=(asset:ISourceAsset,value:string):boolean=>(asset.name+' '+(asset.imported?.name??'')+' '+(asset.description??'')+' '+labels[asset.kind]).toLocaleLowerCase('ru').includes(value.trim().toLocaleLowerCase('ru'));
 const cards=(data?.assets??[]).filter(asset=>matches(asset,query)),localCards=(data?.localAssets??[]).filter(asset=>matches(asset,localQuery));
 const editControls=(asset:ISourceAsset):JSX.Element|null=>asset.imported&&asset.kind!=='bridge'?<><FeatureButton features={[asset.kind === 'model' ? 'model_catalog' : asset.kind === 'agent' ? 'agents' : 'tool_catalog']} loading={editing===asset.id} disabled={!!editing||archive.busy||imports.blocked||asset.imported.archived||asset.imported.unavailable} onClick={()=>void editAsset(asset)}>Редактировать</FeatureButton><ArchiveAssetButton kind={asset.kind} id={asset.imported.id} restore={asset.imported.archived} children={asset.imported.archived?'Вернуть из архива':'Удалить'} onArchived={()=>void load()} disabled={archive.busy||imports.blocked||asset.imported.unavailable}/></>:null;
 const add=(ids:string[]):void=>{if(data?.source.verified&&data.source.commit&&!archiveLock.current&&!imports.blocked&&!catalogAction.current&&ids.every(id=>data.assets.some(asset=>asset.id===id&&sourceAssetReady(asset)&&!asset.imported?.archived&&!asset.imported?.unavailable))){const action={};catalogAction.current=action;void Promise.resolve(imports.start(ids,data.source.commit)).finally(()=>{if(catalogAction.current===action)catalogAction.current=undefined;});}};
 const offline=data?.source.mode==='offline';
 const fromArchive=!!data?.source.archiveSha256;
 const readyUpdates=(data?.assets??[]).filter(asset=>sourceAssetReady(asset)&&asset.imported?.updateAvailable&&!asset.imported.archived&&!asset.imported.unavailable);
 const cancelled=imports.job?.state==='CANCELLED',stopping=!!imports.job&&activeImport(imports.job.state)&&imports.job.cancelRequested;
 const importMessage=stopping?'Остановка запрошена. Уже добавленные карточки сохранятся.':cancelled
  ?'Импорт остановлен. '+(imports.job!.items.length?'Готово: '+imports.job!.items.filter(item=>item.state==='SUCCEEDED').length+' из '+imports.job!.items.length+'. Уже добавленные карточки сохранены.':'Новые карточки не добавлены.')
  :imports.job?.message;
 return <section className="asset-sources"><PageHeading title="Ассеты" description="Выберите инструменты, модели и агентов для общего каталога."
  actions={<Space wrap><Button href="/settings#sources">Настройки источников</Button><FeatureButton features={['asset_sources']} disabled={archiveBlocked||archive.busy} onClick={()=>setArchiveOpen(true)}>Импортировать архив</FeatureButton><Button loading={loading} disabled={imports.blocked||archive.busy} onClick={()=>void load()}>Обновить список</Button><FeatureButton features={['asset_sources']} loading={loading} disabled={imports.blocked||archive.busy} onClick={()=>void load(true)}>{offline?'Перечитать поставку':fromArchive?'Проверить источник в GitHub':'Обновить источник'}</FeatureButton></Space>}/>
  <Space direction="vertical" size="middle" className="asset-sources__content">
   {error&&<Alert type="error" showIcon message={error}/>}
   <AssetImportRecovery imports={imports} onChangeSelection={ids=>{if(captureOwner()()){setSelected(data?availableSourceAssetIds(data.assets,ids):ids);setQuery('');}}}/>
   {imports.job&&<Card size="small" title="Импорт в каталог" className="asset-sources__receipt"><Space direction="vertical" className="asset-sources__content">
    <Typography.Text role="status">{importMessage}</Typography.Text>
    {!!imports.job.items.length&&<details key={imports.job.id} open={activeImport(imports.job.state)||['FAILED','PARTIAL','NEEDS_INPUT'].includes(imports.job.state)}><summary>Результаты · {imports.job.items.length}</summary><div className="asset-sources__receipt-items"><List size="small" dataSource={imports.job.items} renderItem={item=><List.Item><div><Typography.Text>{item.name} · {item.version}</Typography.Text>{!item.current&&<Tag>Точная зависимость</Tag>}<AssetCatalogName sourceName={item.name} catalogName={item.catalogName}/><div><Typography.Text type={!cancelled&&(item.state==='FAILED'||item.action==='conflict')?'danger':'secondary'}>{cancelled&&item.state==='PENDING'?'Не добавлено: импорт остановлен.':item.reason||item.message||itemStates[item.state]||item.state}</Typography.Text></div></div></List.Item>}/></div></details>}
    <Space wrap>{activeImport(imports.job.state)?<Button loading={imports.busy} disabled={stopping} onClick={()=>void imports.cancel()}>{stopping?'Остановка запрошена':'Остановить импорт'}</Button>:<>
     {imports.job.state==='NEEDS_INPUT'&&imports.job.items.some(item=>item.replacement)&&<Button onClick={()=>setResolving(true)}>Решить конфликт</Button>}
     {['FAILED','PARTIAL','NEEDS_INPUT'].includes(imports.job.state)&&<FeatureButton features={['asset_sources']} loading={imports.busy} onClick={()=>void imports.retry()}>{imports.job.state==='NEEDS_INPUT'&&imports.job.items.some(item=>item.action==='conflict')?'Проверить конфликт заново':'Повторить после исправления'}</FeatureButton>}
     <Button onClick={imports.clear}>Новый выбор</Button></>}</Space>
   </Space></Card>}
   {fromArchive&&<AssetArchiveStatus assets={data?.assets??[]} blocked={archiveBlocked||archive.busy} onCompleteSupply={()=>{if(!archiveBlocked&&!archive.busy)setArchiveOpen(true);}}/>}
   {offline&&<Alert type="info" showIcon message="Автономная поставка" description={fromArchive?'Сервер работает автономно. «Перечитать поставку» перепроверяет выбранную локальную опись без обращения к GitHub.':'Описи и файлы читаются из локальной поставки, закреплённой точным commit. Новые ассеты появятся после загрузки обновлённой поставки на сервер. GitHub не запрашивается.'}/>}
   {data?.source.error&&<Alert type="warning" showIcon message={data.source.error} description="Показана последняя проверенная опись. Она закреплена точным commit; обновление не меняет уже добавленные карточки."/>}
   <Typography.Text type="secondary">{fromArchive?'Архив · '+data?.source.archiveSha256?.slice(0,12):offline?(data?.source.verified?'Локальная поставка · '+data.source.commit?.slice(0,8):'Загрузите архив или перечитайте локальную поставку.'):data?.source.verified?'Проверено '+new Date(data.source.checkedAt!).toLocaleString('ru-RU')+' · '+data.source.commit?.slice(0,8):'Загрузите архив или обновите источник.'}</Typography.Text>
   <section className="asset-sources__repository" aria-label="Из репозитория ассетов"><Typography.Title level={3}>Из репозитория ассетов</Typography.Title>
   <div className="asset-sources__section-toolbar"><Input.Search aria-label="Поиск ассетов в репозитории" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Найти в репозитории" allowClear/>
    {!!readyUpdates.length&&<FeatureButton features={['asset_sources']} disabled={imports.blocked||archive.busy||!data?.source.verified} onClick={()=>{if(!imports.blocked&&!archive.busy&&data?.source.verified){setSelected(readyUpdates.slice(0,ASSET_IMPORT_MAX_ITEMS).map(asset=>asset.id));setQuery('');}}}>Выбрать готовые обновления</FeatureButton>}
    <FeatureButton features={['asset_sources',...new Set((data?.assets??[]).filter(asset=>selected.includes(asset.id)).map(asset=>assetCatalogFeature(asset.kind)))]} type="primary" disabled={!selected.length||!data?.source.verified||imports.blocked||archive.busy} loading={imports.busy&&!imports.job} onClick={()=>add(selected)}>Импортировать выбранные{selected.length?' ('+selected.length+')':''}</FeatureButton>
   </div>
   {readyUpdates.length>ASSET_IMPORT_MAX_ITEMS&&<Typography.Paragraph type="secondary">За один импорт можно выбрать до {ASSET_IMPORT_MAX_ITEMS} карточек. Кнопка обновлений выбирает первые {ASSET_IMPORT_MAX_ITEMS}; остальные обновите после завершения этой порции.</Typography.Paragraph>}
   {loading&&!data?<Spin/>:cards.length?<div className="asset-sources__grid">{cards.map(asset=><Card key={asset.id} size="small" className="asset-sources__card"
    title={<Space align="start"><Checkbox aria-label={'Выбрать '+asset.name} disabled={imports.blocked||archive.busy||!data?.source.verified||!sourceAssetReady(asset)||asset.imported?.archived||asset.imported?.unavailable} checked={selected.includes(asset.id)} onChange={e=>setSelected(previous=>e.target.checked?[...new Set([...previous,asset.id])]:previous.filter(id=>id!==asset.id))}/><span>{asset.name}</span></Space>}>
    <div className="asset-sources__card-content"><Space wrap><Tag>{labels[asset.kind]}</Tag><Typography.Text type="secondary">{asset.version} · {asset.license}</Typography.Text></Space>
     <Typography.Paragraph>{asset.description||'Описание не добавлено в источник.'}</Typography.Paragraph>
     {!!asset.dependencies.length&&<Typography.Text type="secondary">Включает точные зависимости: {asset.dependencies.map(dep=>dep.id+' '+dep.version).join(', ')}</Typography.Text>}
     {asset.supply&&<Typography.Text type={asset.supply.ready?'secondary':'warning'}>{asset.supply.ready?'Файлы и зависимости готовы':'Не хватает файлов: '+asset.supply.missingFiles+' · '+(asset.supply.missingBytes<1000?asset.supply.missingBytes+' Б':formatBytes(asset.supply.missingBytes))}</Typography.Text>}
     {asset.imported&&<Typography.Text type="secondary">В каталоге: версия источника {asset.imported.originVersion}{asset.imported.archived?' · в архиве':asset.imported.updateAvailable?' · доступно обновление':''}</Typography.Text>}
     {(asset.kind==='mcp'||asset.kind==='plugin')&&<AssetCatalogName sourceName={asset.name} catalogName={asset.imported?.name}/>}
     <div className="asset-sources__card-actions"><FeatureButton features={['asset_sources',assetCatalogFeature(asset.kind)]} type="primary" disabled={imports.blocked||archive.busy||!data?.source.verified||!sourceAssetReady(asset)||asset.imported?.archived||asset.imported?.unavailable} onClick={()=>add([asset.id])}>{asset.imported?(asset.imported.updateAvailable?'Обновить':'Проверить и добавить'):'Добавить'}</FeatureButton>
      {editControls(asset)}
     </div>
    </div>
   </Card>)}</div>:<Empty description={data?.source.verified?'По выбранному запросу ассетов нет.':offline?'Загрузите архив или перечитайте локальную поставку, чтобы выбрать ассеты.':'Загрузите архив или обновите источник, чтобы выбрать ассеты.'}/>}
   </section>
   {!!data?.localAssets?.length&&<LocalAssetCards assets={localCards} actions={editControls} query={localQuery} onQuery={setLocalQuery} total={data.localAssets.length}/>}
  </Space>
  <AssetArchiveModal key={'archive:'+scope} open={archiveOpen} blocked={archiveBlocked} upload={archive} onClose={()=>{if(captureOwner()())setArchiveOpen(false);}}/>
  <Modal open={resolving} title="Заменить локальные карточки источником?" onCancel={()=>{if(!imports.busy){setResolving(false);}}} confirmLoading={imports.busy} okText="Заменить содержимое" cancelText="Оставить локальные"
   okButtonProps={{danger:true,disabled:!imports.job?.items.filter(item=>item.action==='conflict').every(item=>!!item.replacement)}} onOk={()=>{void imports.resolve().then(()=>setResolving(false));}}>
   <Typography.Paragraph>Содержимое выбранных локальных карточек будет заменено точной версией источника. Прежние версии, файлы и закреплённые версии проектов сохранятся.</Typography.Paragraph>
   <List dataSource={imports.job?.items.filter(item=>item.action==='conflict')} renderItem={item=><List.Item><div><Typography.Text strong>{item.name}</Typography.Text><AssetCatalogName sourceName={item.name} catalogName={item.catalogName}/><div>Локальная версия: {item.replacement?.version??'замена недоступна'} → источник {item.version}</div><Typography.Text type="secondary">{item.reason}</Typography.Text></div></List.Item>}/>
  </Modal>
  <StoreEditModal key={scope} editApp={edit} onClose={()=>setEdit(null)} onSaved={()=>void load()}/>
  {model&&<ModelEditModal key={model.id+':'+scope} model={model} onClose={()=>setModel(undefined)} onSaved={()=>load()}/>}
  {agent&&<AgentEditModal key={agent.id+':'+agent.version+':'+scope} agent={agent} onClose={()=>setAgent(undefined)} onSaved={()=>load()}/>}
 </section>;
}
