import {FeatureButton} from '../FeatureFlags/FeatureAvailability';
import {Alert,Button,Checkbox,Form,Input,Modal,Popconfirm,Select,Space,Spin,Typography} from 'antd';
import {useLayoutEffect,useRef,useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {modelCatalogApi} from './api';
import type {ICatalogModel,IRemoteConnection,IRemoteConnectionHint,IRemoteConnectionInput} from './types';
import {isRemoteApiUrl,remoteModelOptions,type TRemoteModelOptionValues} from './remoteModelForm';
import {RemoteModelParameters} from './RemoteModelParameters';

interface Props {model:ICatalogModel;hint?:IRemoteConnectionHint;onClose:()=>void;onSaved:()=>Promise<void>;}
type Values=Pick<IRemoteConnectionInput,'baseUrl'|'requestDimensions'|'authMode'>&{options?:TRemoteModelOptionValues;timeoutMs?:number|null};

/** Provider configuration is shared; personal secrets are entered separately in My Access. */
export function RemoteConnectionModal(props:Props):JSX.Element{
    const {scope}=useAuthRequestOwner();
    return <ProviderConnectionForm key={JSON.stringify([scope,props.model.id,props.model.revision])} {...props}/>;
}
function ProviderConnectionForm({model,hint,onClose,onSaved}:Props):JSX.Element{
    const {scope,captureOwner}=useAuthRequestOwner(),[form]=Form.useForm<Values>();
    const ownerKey=JSON.stringify([scope,model.id,model.revision]),currentOwner=useRef(ownerKey);currentOwner.current=ownerKey;
    const [loadedFor,setLoadedFor]=useState('');
    const [view,setView]=useState<IRemoteConnection>(),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
    const mounted=useRef(false),lock=useRef(false);
    const read=async()=>{
        const owns=captureOwner(),at=ownerKey;setLoading(true);setError('');
        const active=()=>owns()&&mounted.current&&currentOwner.current===at;
        try{const value=await modelCatalogApi.connection(model.id);if(!active())return;
            if(value.modelId!==model.id||value.modelRevision!==model.revision)throw Error('Карточка модели изменилась. Обновите каталог и откройте настройку снова.');
            setView(value);form.resetFields();form.setFieldsValue({baseUrl:value.baseUrl||hint?.baseUrl,requestDimensions:value.requestDimensions,
                authMode:value.authMode??(value.credential==='none'?'none':'required'),options:value.baseUrl?value.options:hint?.options??value.options,timeoutMs:value.baseUrl?value.timeoutMs:hint?.timeoutMs??value.timeoutMs});
        }catch(cause){if(active())setError(errorMessage(cause,'Не удалось прочитать настройки провайдера.'));}
        finally{if(active()){setLoading(false);setLoadedFor(at);}}
    };
    useLayoutEffect(()=>{mounted.current=true;setView(undefined);setSaved(false);void read();return()=>{mounted.current=false;};},[ownerKey,captureOwner]);
    const submit=async(values:Values)=>{
        const owns=captureOwner();if(!owns()||!view||view.modelId!==model.id||loadedFor!==ownerKey||lock.current)return;lock.current=true;setBusy(true);setError('');
        let accepted=saved;
        try{
            if(!accepted){const result=await modelCatalogApi.configure(model.id,{expectedRevision:view.revision,expectedModelRevision:view.modelRevision,
                baseUrl:values.baseUrl.trim(),requestDimensions:!!values.requestDimensions,authMode:values.authMode,credential:'none',
                options:remoteModelOptions(values.options,model),timeoutMs:values.timeoutMs??90000});
                if(!owns()||!mounted.current)return;setView(result);setSaved(true);accepted=true;}
            await onSaved();if(owns()&&mounted.current)onClose();
        }catch(cause){if(owns()&&mounted.current)setError((accepted?'Провайдер сохранён. Не удалось обновить каталог: ':'')+errorMessage(cause,'Настройка не подтверждена; введённые значения сохранены.'));}
        finally{lock.current=false;if(owns()&&mounted.current)setBusy(false);}
    };
    const revoke=async()=>{
        const owns=captureOwner();if(!owns()||!view||lock.current)return;lock.current=true;setBusy(true);setError('');
        try{await modelCatalogApi.revoke({...model,revision:view.modelRevision},view.revision);if(!owns()||!mounted.current)return;await onSaved();if(owns()&&mounted.current)onClose();}
        catch(cause){if(owns()&&mounted.current)setError(errorMessage(cause,'Не удалось отозвать подключение. Переключите использующие его проекты и повторите.'));}
        finally{lock.current=false;if(owns()&&mounted.current)setBusy(false);}
    };
    return <Modal open centered className="model-details" title={`Провайдер «${model.name}»`} width={620} footer={null}
        onCancel={()=>{if(!lock.current)onClose();}} closable={!busy} maskClosable={!busy} keyboard={!busy}>
        {error&&<Alert showIcon type="error" message={error} className="model-catalog__notice" action={!view?<Button onClick={()=>{void read();}}>Повторить</Button>:undefined}/>}
        {loading||loadedFor!==ownerKey?<Spin tip="Читаем настройки…"/>:view&&<Form form={form} layout="vertical" disabled={busy||saved} onFinish={values=>{void submit(values);}}>
            <Typography.Paragraph type="secondary">Адрес и параметры провайдера общие для команды. Каждый пользователь вводит собственный ключ в разделе «Мой доступ» карточки модели. Сохранение не выполняет запрос к модели.</Typography.Paragraph>
            {hint?.hasKey&&<Alert showIcon type="info" message="Ключ OpenCode остаётся на компьютере" description="Локальная авторизация OpenCode не переносится на сервер." className="model-catalog__notice"/>}
            <Form.Item name="baseUrl" label="Адрес API" extra="Запрос выполняет сервер: localhost относится к серверу Нейроцентра." rules={[{required:true,whitespace:true,message:'Укажите адрес API'},{validator:(_rule,value)=>!value||isRemoteApiUrl(value)?Promise.resolve():Promise.reject(Error('Укажите HTTP(S) адрес без пароля, ключа и параметров'))}]}>
                <Input autoComplete="off" placeholder={model.runtime==='remote-openai'?'https://provider.example/v1':'http://models.internal:11434'}/>
            </Form.Item>
            <Form.Item name="authMode" label="Авторизация пользователей" rules={[{required:true,message:'Выберите режим авторизации'}]}><Select options={[{value:'none',label:'Без ключа'},{value:'optional',label:'Личный ключ необязателен'},{value:'required',label:'Личный API-ключ обязателен'}]}/></Form.Item>
            {view.credential!=='none'&&<Typography.Paragraph type="secondary">Прежний общий секрет остаётся сохранённым. Новые запросы его не используют.</Typography.Paragraph>}
            {model.capability==='embedding'&&<Form.Item name="requestDimensions" valuePropName="checked"><Checkbox>Запрашивать {model.dimension||'указанную'} размерность</Checkbox></Form.Item>}
            <RemoteModelParameters model={model}/>
            <Space wrap className="model-catalog__form-actions">
                {view.revision>0&&view.baseUrl&&<Popconfirm title="Отозвать все версии подключения?" okText="Отозвать" cancelText="Отмена" onConfirm={()=>{void revoke();}}><Button danger disabled={busy}>Отозвать подключение</Button></Popconfirm>}
                <Button disabled={busy} onClick={onClose}>Отмена</Button>
                <FeatureButton features={saved?[]:['model_catalog','personal_remote_provider_credentials']} type="primary" htmlType="submit" loading={busy} disabled={busy}>{saved?'Обновить каталог':'Сохранить провайдера'}</FeatureButton>
            </Space>
        </Form>}
    </Modal>;
}
