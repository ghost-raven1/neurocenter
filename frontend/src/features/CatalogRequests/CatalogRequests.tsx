import {Alert,Button,Card,Empty,List,Pagination,Select,Space,Tag,Typography} from 'antd';
import {useEffect,useState} from 'react';
import {CatalogRequestButton} from './CatalogRequestButton';
import {RequestDetails} from './RequestDetails';
import {requestAssetLabel,requestAssets,requestKindLabel,requestKinds,requestStates,requestTime} from './presentation';
import {useCatalogRequests} from './useCatalogRequests';
import type {IRequestAssetType,IRequestFilters,IRequestKind,IRequestProject,IRequestStatus} from './types';
import './CatalogRequests.less';

interface IProps {projects:IRequestProject[];projectId?:string;scope:string}

/** One queue covers intake and review; the server limits “all” to owned or reviewable requests. */
export function CatalogRequests({projects,projectId,scope}:IProps):JSX.Element {
    const [filters,setFilters]=useState<IRequestFilters>({scope:'mine',page:1,size:20,projectId}),[selected,setSelected]=useState<string|null>(null);
    useEffect(()=>{setFilters({scope:'mine',page:1,size:20,projectId});setSelected(null);},[scope,projectId]);
    const {page,loading,error,accessDenied,refresh}=useCatalogRequests(filters);
    useEffect(()=>{if(accessDenied)setSelected(null);},[accessDenied]);
    const change=(value:Partial<IRequestFilters>):void=>setFilters(previous=>({...previous,...value,page:1}));
    const filterActive=!!filters.status||!!filters.kind||!!filters.assetType;
    useEffect(()=>{if(page&&filters.page>1&&page.total<=(filters.page-1)*filters.size)setFilters(previous=>({...previous,page:Math.max(1,Math.ceil(page.total/filters.size))}));},[page,filters.page,filters.size]);
    return <div className="catalog-requests">
        <div className="catalog-requests__heading"><div><Typography.Title level={3}>Заявки по каталогу</Typography.Title><Typography.Paragraph type="secondary">Предложите новый инструмент, обновление или сообщите о проблеме. Рассмотрение и результат видны в истории.</Typography.Paragraph></div><Space wrap><Button loading={loading} onClick={()=>{void refresh();}}>Обновить заявки</Button><CatalogRequestButton projects={projects} projectId={projectId} onSaved={value=>{setSelected(value.id);void refresh();}}/></Space></div>
        <div className="catalog-requests__filters">
            <Select aria-label="Чьи заявки" value={filters.scope} onChange={value=>change({scope:value as IRequestFilters['scope']})} options={[{value:'mine',label:'Мои заявки'},{value:'all',label:'Все доступные'}]}/>
            <Select aria-label="Статус заявки" placeholder="Любой статус" allowClear value={filters.status} onChange={value=>change({status:value as IRequestStatus|undefined})} options={Object.entries(requestStates).map(([value,item])=>({value,label:item.label}))}/>
            <Select aria-label="Тип обращения в списке" placeholder="Любое обращение" allowClear value={filters.kind} onChange={value=>change({kind:value as IRequestKind|undefined})} options={requestKinds}/>
            <Select aria-label="Тип инструмента в списке" placeholder="Все типы" allowClear value={filters.assetType} onChange={value=>change({assetType:value as IRequestAssetType|undefined})} options={requestAssets}/>
            {filterActive&&<Button onClick={()=>change({status:undefined,kind:undefined,assetType:undefined})}>Сбросить фильтры</Button>}
        </div>
        <Typography.Paragraph type="secondary">«Все доступные» включает ваши заявки и те, которые вы можете рассматривать.{projectId?' Показаны заявки выбранного проекта.':' Проект выбирается в каждой заявке.'}</Typography.Paragraph>
        {error&&<Alert role="alert" type="error" showIcon message={page?'Не удалось обновить заявки — показан предыдущий список':'Не удалось загрузить заявки'} description={error} action={<Button size="small" loading={loading} onClick={()=>{void refresh();}}>Повторить загрузку заявок</Button>}/>}
        <List loading={loading} dataSource={page?.items??[]} locale={{emptyText:<Empty description={error?'Список заявок недоступен':filterActive?'По этим фильтрам заявок нет':'Заявок пока нет'}/>}}
            renderItem={item=><List.Item key={item.id}><Card size="small" className="catalog-requests__card"><div className="catalog-requests__card-heading"><Button type="link" aria-label={'Открыть заявку: '+item.title} onClick={()=>setSelected(item.id)}>{item.title}</Button><Tag color={requestStates[item.status].color}>{requestStates[item.status].label}</Tag></div><Space wrap size={[8,4]}><Tag>{requestAssetLabel(item.assetType)}</Tag><Typography.Text>{requestKindLabel(item.kind)}</Typography.Text><Typography.Text type="secondary">{item.projectName??(item.projectId?'Проект недоступен':'Общий каталог')}</Typography.Text></Space><Typography.Paragraph ellipsis={{rows:2}} className="catalog-requests__description">{item.description}</Typography.Paragraph><Space wrap size={[12,4]}><Typography.Text type="secondary">{item.createdBy}</Typography.Text><Typography.Text type="secondary">{requestTime(item.updatedAt)}</Typography.Text></Space></Card></List.Item>}/>
        {page&&page.total>0&&<Pagination current={filters.page} total={page.total} pageSize={filters.size} showSizeChanger={false} onChange={value=>setFilters(previous=>({...previous,page:value}))} showTotal={total=>'Всего заявок: '+total}/>}
        {selected&&!accessDenied&&<RequestDetails key={scope+':'+selected} id={selected} projects={projects} onClose={()=>setSelected(null)} onChanged={()=>{void refresh();}}/>}
    </div>;
}
