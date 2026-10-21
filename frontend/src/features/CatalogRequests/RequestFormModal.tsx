import {Alert,Button,Form,Input,Modal,Select,Space,Typography} from 'antd';
import {isAxiosError} from 'axios';
import {useEffect,useId,useRef,useState} from 'react';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {errorMessage} from '../../common/utils/errorMessage';
import {catalogRequestsApi} from './api';
import {requestEditPayload,requestPayload,requireRequest} from './model';
import {requestAssets,requestKinds,requestSourceUrl} from './presentation';
import {createRequestKeys} from './requestKeys';
import {readPendingCreation,savePendingCreation,clearPendingCreation} from './pendingCreation';
import {RequestTargetPicker} from './RequestTargetPicker';
import type {ICatalogRequest,IRequestAssetType,IRequestCreate,IRequestProject} from './types';

interface IValues extends Omit<IRequestCreate,'target'> {targetId?:string}
interface IProps {open:boolean;projects:IRequestProject[];projectId?:string;assetType?:IRequestAssetType;request?:ICatalogRequest;onClose:()=>void;onDenied?:()=>void;onSaved:(value:ICatalogRequest)=>void}

/** A missing acknowledgement freezes its intent until the same key is retried. Drafts survive failures. */
export function RequestFormModal({open,projects,projectId,assetType='plugin',request,onClose,onDenied,onSaved}:IProps):JSX.Element {
    const {scope,captureOwner}=useAuthRequestOwner();
    const [form]=Form.useForm<IValues>();
    const formId=useId();
    const kind=Form.useWatch('kind',form)??request?.kind??'add';
    const selectedType=Form.useWatch('assetType',form)??request?.assetType??assetType;
    const selectedProject=Form.useWatch('projectId',form)??request?.projectId??projectId;
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[unconfirmed,setUnconfirmed]=useState(false),[storageError,setStorageError]=useState(false),[storageRetry,setStorageRetry]=useState(0);
    const lock=useRef(false),keys=useRef(createRequestKeys()),pending=useRef<{payload:IRequestCreate;key:string}>(),dirty=useRef(false);
    const context=JSON.stringify([assetType,projectId??null]),previousContext=useRef(context);
    useEffect(()=>{
        if(request||previousContext.current===context)return;
        previousContext.current=context;
        if(!dirty.current&&!pending.current)form.setFieldsValue({kind:'add',assetType,projectId:projectId??'',targetId:undefined});
    },[context,request,assetType,projectId,form]);
    const restore=():void=>{
        if(request)return;
        try{
            const previous=readPendingCreation(scope);setStorageError(false);setError('');
            if(previous){pending.current=previous;form.setFieldsValue({...previous.payload,projectId:previous.payload.projectId??'',sourceUrl:previous.payload.sourceUrl??'',targetId:previous.payload.target?.id});setUnconfirmed(true);}
        }catch(cause){setStorageError(true);setError(errorMessage(cause,'Не удалось проверить предыдущую отправку.'));}
    };
    useEffect(()=>{if(open)restore();},[open,scope,storageRetry]);
    const submit=async(values:IValues):Promise<void>=>{
        const owns=captureOwner();if(!owns()||lock.current||storageError)return;
        if(!request&&!pending.current){try{if(readPendingCreation(scope)){restore();return;}}catch(cause){setStorageError(true);setError(errorMessage(cause,'Не удалось проверить предыдущую отправку.'));return;}}
        try{
            const payload=pending.current?.payload??requestPayload({...values,target:values.targetId?{type:values.assetType,id:values.targetId}:undefined});
            const key=pending.current?.key??keys.current.forIntent(request?'edit:'+request.id:'create',{...payload,revision:request?.revision});
            if(!request){try{savePendingCreation(scope,{schemaVersion:1,payload,key});}catch(cause){setStorageError(true);setError(errorMessage(cause,'Заявка не отправлена.'));return;}}
            pending.current={payload,key};lock.current=true;setBusy(true);setError('');
            const saved=request?await catalogRequestsApi.edit(request.id,requestEditPayload(payload),request.revision,key):await catalogRequestsApi.create(payload,key);
            requireRequest(saved);if(!owns())return;
            if(!request)clearPendingCreation(scope,key);
            pending.current=undefined;setUnconfirmed(false);keys.current.clear();dirty.current=false;form.resetFields();onSaved(saved);
        }catch(cause){
            if(owns()){
                const status=isAxiosError(cause)?cause.response?.status:undefined;
                if(status===401||status===403){if(!request&&pending.current){try{clearPendingCreation(scope,pending.current.key);}catch{setStorageError(true);}}pending.current=undefined;dirty.current=false;form.resetFields();onDenied?.();onClose();return;}
                const ambiguous=!!pending.current&&(status===undefined||status>=500||status===408);
                setUnconfirmed(ambiguous);if(!ambiguous){if(!request&&pending.current){try{clearPendingCreation(scope,pending.current.key);}catch(storageCause){setStorageError(true);setUnconfirmed(true);setError(errorMessage(storageCause,'Не удалось обновить подтверждение.'));return;}}pending.current=undefined;}
                setError(errorMessage(cause,request?'Не удалось сохранить заявку. Введённые данные сохранены.':'Не удалось подтвердить приём заявки.'));
            }
        }finally{lock.current=false;if(owns())setBusy(false);}
    };
    const initial:IValues=request?{kind:request.kind,assetType:request.assetType,title:request.title,description:request.description,sourceUrl:request.sourceUrl??'',projectId:request.projectId??'',targetId:request.target?.id}
        :{kind:'add',assetType,title:'',description:'',sourceUrl:'',projectId:projectId??''};
    const disabled=busy||unconfirmed||storageError;
    return <Modal centered bodyStyle={{maxHeight:'calc(100dvh - 180px)',overflowY:'auto'}} open={open} title={request?'Редактирование заявки':'Новая заявка'} width={640} footer={null} forceRender
        onCancel={()=>{if(!lock.current)onClose();}} closable={!busy} maskClosable={!busy} keyboard={!busy}>
        <Form form={form} name={(request?'catalog-request-edit-':'catalog-request-create-')+formId} layout="vertical" initialValues={initial} disabled={disabled}
            onValuesChange={()=>{dirty.current=true;setError('');}} onFinish={values=>{void submit(values);}} scrollToFirstError={{block:'center'}}>
            <Form.Item name="kind" label="Тип обращения" rules={[{required:true}]}><Select disabled={disabled||!!request} options={requestKinds} onChange={()=>form.setFieldsValue({targetId:undefined})}/></Form.Item>
            <Form.Item name="assetType" label="Что требуется" rules={[{required:true}]}><Select disabled={disabled||!!request} options={requestAssets} onChange={()=>form.setFieldsValue({targetId:undefined})}/></Form.Item>
            <Form.Item name="projectId" label="Проект" extra="Без проекта — заявка в общий каталог; её рассматривает главный администратор."><Select disabled={disabled||!!request} options={[{value:'',label:'Общий каталог'},...projects.map(project=>({value:project.id,label:project.name}))]} onChange={()=>form.setFieldsValue({targetId:undefined})}/></Form.Item>
            {kind!=='add'&&<Form.Item name="targetId" label="Карточка каталога" rules={[{required:true,message:'Выберите существующую карточку'}]}>
                <RequestTargetPicker assetType={selectedType} projectId={selectedProject} initial={request?.target} disabled={disabled}/>
            </Form.Item>}
            <Form.Item name="title" label="Название" rules={[{required:true,whitespace:true,message:'Кратко назовите задачу'},{max:128,message:'До 128 символов'}]}><Input placeholder="Например, добавить MCP для GitHub" maxLength={128}/></Form.Item>
            <Form.Item name="description" label="Описание" rules={[{required:true,whitespace:true,message:'Расскажите, что требуется и зачем'},{max:4000,message:'До 4000 символов'}]}><Input.TextArea rows={4} showCount maxLength={4000} placeholder={kind==='issue'?'Что произошло, как повторить и что ожидалось':'Что нужно сделать и для какой задачи'}/></Form.Item>
            <Form.Item name="sourceUrl" label="Ссылка на источник" extra="Необязательно. Ссылка сохраняется для рассмотрения; скачивание и установка не запускаются." rules={[{validator:(_,value:string|undefined)=>{try{requestSourceUrl(value);return Promise.resolve();}catch(cause){return Promise.reject(cause);}}}]}><Input placeholder="https://github.com/owner/repository" maxLength={2048}/></Form.Item>
            {error&&<Alert role="alert" showIcon type="error" message={error}/>}
            {storageError&&<Alert type="warning" showIcon message="Новая отправка приостановлена" description="Предыдущая заявка могла быть принята. Сначала проверьте сохранённый запрос и список своих заявок." action={<Button disabled={busy} onClick={()=>setStorageRetry(value=>value+1)}>Повторить проверку отправки</Button>}/>}
            {unconfirmed&&<Alert type="warning" showIcon message="Подтверждение не получено" description="Повторите отправку: используется тот же запрос, поэтому вторая заявка не создаётся. До подтверждения его поля заблокированы."/>}
            {request&&<Typography.Paragraph type="secondary">Сохранение уточнения не отправляет заявку повторно. После проверки нажмите «Отправить на рассмотрение» в её карточке.</Typography.Paragraph>}
            <Space wrap className="catalog-requests__form-actions"><Button disabled={busy} onClick={onClose}>Закрыть</Button><Button type="primary" disabled={busy||storageError} loading={busy} onClick={()=>{if(unconfirmed&&pending.current){void submit(form.getFieldsValue(true));}else form.submit();}}>{unconfirmed?'Проверить / повторить предыдущую отправку':request?'Сохранить изменения':'Отправить заявку'}</Button></Space>
        </Form>
    </Modal>;
}
