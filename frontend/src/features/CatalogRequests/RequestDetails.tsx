import {Alert,Button,Descriptions,Empty,Space,Spin,Tag,Timeline,Typography} from 'antd';
import {isAxiosError} from 'axios';
import {useCallback,useEffect,useRef,useState} from 'react';
import AccessibleDrawer from '../../common/components/AccessibleDrawer';
import {errorMessage} from '../../common/utils/errorMessage';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {catalogRequestsApi} from './api';
import {requireRequestDetail} from './model';
import {requestAssetLabel,requestKindLabel,requestSourceUrl,requestStates,requestTime} from './presentation';
import {RequestActions} from './RequestActions';
import {RequestFormModal} from './RequestFormModal';
import type {IRequestDetail,IRequestProject} from './types';

interface IProps {id:string;projects:IRequestProject[];onClose:()=>void;onChanged:()=>void}
const historyActions:Record<string,string>={create:'Заявка отправлена',edit:'Заявка изменена',start:'Взята в работу',needs_info:'Запрошено уточнение',reject:'Заявка отклонена',complete:'Заявка выполнена',resubmit:'Отправлена повторно',cancel:'Заявка отменена'};

/** Read access is rechecked for every detail refresh; revoked resources never keep old private content visible. */
export function RequestDetails({id,projects,onClose,onChanged}:IProps):JSX.Element {
    const {captureOwner}=useAuthRequestOwner();
    const [request,setRequest]=useState<IRequestDetail|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[editing,setEditing]=useState<IRequestDetail|null>(null),[editingOpen,setEditingOpen]=useState(false),[busy,setBusy]=useState(false);
    const sequence=useRef(0);
    const refresh=useCallback(async():Promise<void>=>{
        const owns=captureOwner(),read=++sequence.current,current=()=>owns()&&sequence.current===read;
        if(!owns())return;setLoading(true);
        try{const value=requireRequestDetail(await catalogRequestsApi.get(id));if(current()){setRequest(previous=>previous&&previous.revision>value.revision?previous:value);setError('');}}
        catch(cause){if(current()){
            if(isAxiosError(cause)&&[401,403,404].includes(cause.response?.status??0)){setRequest(null);setEditing(null);setEditingOpen(false);}
            setError(errorMessage(cause,'Не удалось загрузить заявку. Повторите попытку.'));
        }}finally{if(current())setLoading(false);}
    },[captureOwner,id]);
    useEffect(()=>{setRequest(null);setEditing(null);setEditingOpen(false);void refresh();return()=>{sequence.current++;};},[refresh]);
    useSectionUpdates(['requests'],()=>{void refresh();});
    let source:string|null=null;try{source=requestSourceUrl(request?.sourceUrl);}catch{}
    const target=request?.target;
    const denied=():void=>{setRequest(null);setEditing(null);setEditingOpen(false);void refresh();};
    const saved=():void=>{setEditing(null);setEditingOpen(false);void refresh();onChanged();};
    return <AccessibleDrawer open title={request?'Заявка: '+request.title:'Заявка'} width="min(720px, 100vw)" onClose={()=>{if(!busy)onClose();}} closable={!busy} maskClosable={!busy} keyboard={!busy}>
        <Space className="catalog-requests__detail-tools" wrap><Button loading={loading} disabled={busy} onClick={()=>{void refresh();}}>Обновить заявку</Button>{(request?.permissions.canEdit||editing)&&<Button disabled={loading||!!error||busy} onClick={()=>{if(!editing&&request)setEditing(request);setEditingOpen(true);}}>{editing&&!editingOpen?'Открыть черновик изменений':'Редактировать заявку'}</Button>}</Space>
        {error&&<Alert role="alert" showIcon type="error" message={request?'Не удалось обновить заявку — показаны предыдущие данные':'Заявка недоступна'} description={error}/>}
        {loading&&!request?<Spin tip="Загружаем заявку…"/>:request?<>
            <Space wrap><Tag color={requestStates[request.status].color}>{requestStates[request.status].label}</Tag><Tag>{requestAssetLabel(request.assetType)}</Tag><Typography.Text>{requestKindLabel(request.kind)}</Typography.Text></Space>
            <Typography.Title level={4}>{request.title}</Typography.Title>
            <Typography.Paragraph className="catalog-requests__text">{request.description}</Typography.Paragraph>
            <Descriptions column={1} size="small">
                <Descriptions.Item label="Проект">{request.projectName??(request.projectId?'Проект недоступен':'Общий каталог')}</Descriptions.Item>
                <Descriptions.Item label="Автор">{request.createdBy}</Descriptions.Item>
                <Descriptions.Item label="Создана">{requestTime(request.createdAt)}</Descriptions.Item>
                <Descriptions.Item label="Обновлена">{requestTime(request.updatedAt)}</Descriptions.Item>
                {request.sourceUrl&&<Descriptions.Item label="Источник">{source?<a href={source} target="_blank" rel="noreferrer">{request.sourceUrl}</a>:<Typography.Text>{request.sourceUrl}</Typography.Text>}</Descriptions.Item>}
                {target&&<Descriptions.Item label={request.status==='completed'?'Связанная карточка результата':'Карточка каталога'}><div><Typography.Text strong>{target.name}</Typography.Text> · v{target.version}<div><Typography.Text type="secondary">{requestAssetLabel(target.type)} · {target.id}</Typography.Text></div>{target.available===false&&<Typography.Text type="danger">Карточка удалена или убрана из каталога</Typography.Text>}{target.available===null&&<Typography.Text type="warning">Доступность карточки не удалось проверить</Typography.Text>}</div></Descriptions.Item>}
            </Descriptions>
            <RequestActions request={request} disabled={loading||!!error||editingOpen} onRefresh={refresh} onBusyChange={setBusy} onDenied={denied} onSaved={value=>{setRequest(previous=>previous&&previous.id===value.id&&value.revision>=previous.revision?value:previous);onChanged();}}/>
            <Typography.Title level={5}>История заявки</Typography.Title>
            <Timeline>{request.history.map(event=><Timeline.Item key={event.id}><Space wrap><Typography.Text strong>{historyActions[event.action]??event.action}</Typography.Text><Typography.Text type="secondary">{requestTime(event.at)}</Typography.Text></Space><div><Typography.Text type="secondary">{event.actor} · {requestStates[event.toStatus]?.label??event.toStatus}</Typography.Text></div>{event.comment&&<Typography.Paragraph className="catalog-requests__text">{event.comment}</Typography.Paragraph>}</Timeline.Item>)}</Timeline>
        </>:<Empty description="Нет доступной заявки"/>}
        {editing&&<RequestFormModal key={editing.id+':'+editing.revision} open={editingOpen} projects={projects} request={editing} onDenied={denied} onClose={()=>setEditingOpen(false)} onSaved={saved}/>}
    </AccessibleDrawer>;
}
