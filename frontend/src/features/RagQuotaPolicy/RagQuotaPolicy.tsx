import {Alert,Button,Card,Form,InputNumber,Space,Spin,Typography} from 'antd';
import {useEffect,useRef,useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import base from '../../core/api/base';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {errorMessage} from '../../common/utils/errorMessage';
import {authDataScope} from '../UserBlock/authDataScope';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {MIB,quotaBytes,requirePlatformQuota,type IPlatformQuotaPolicy} from './model';

type Draft={defaultMiB:number;maximumMiB:number};
const path='/api/maintenance/rag-quota-policy';

function QuotaPolicyForm():JSX.Element {
    const {captureOwner}=useAuthRequestOwner();const [form]=Form.useForm<Draft>();
    const [policy,setPolicy]=useState<IPlatformQuotaPolicy>();const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[dirty,setDirty]=useState(false),[error,setError]=useState('');
    const edited=useRef(false),revision=useRef<number>(),epoch=useRef(0),busy=useRef(false);
    const pending=useRef<AbortController>();
    const load=async(adopt=false):Promise<void>=>{
        pending.current?.abort();const controller=new AbortController();pending.current=controller;
        const owns=captureOwner(),request=++epoch.current;setLoading(true);
        try {
            const value=requirePlatformQuota((await base.get<unknown>(path,{signal:controller.signal,timeout:15000})).data);
            if(!owns()||request!==epoch.current)return;
            setPolicy(value);setError('');
            if(!edited.current){form.setFieldsValue({defaultMiB:value.defaultBytes/MIB,maximumMiB:value.maximumBytes/MIB});revision.current=value.revision;}
            else if(adopt)revision.current=value.revision;
        }catch(failure){if(!controller.signal.aborted&&owns()&&request===epoch.current)setError(errorMessage(failure,'Не удалось получить настройки квот.'));}
        finally{if(owns()&&request===epoch.current)setLoading(false);}
    };
    useEffect(()=>{void load();return()=>{epoch.current++;pending.current?.abort();};},[captureOwner]);
    useSectionUpdates(['maintenance'],()=>{if(!busy.current)void load();});
    const save=async(draft:Draft):Promise<void>=>{
        if(busy.current||revision.current===undefined)return;
        const owns=captureOwner();if(!owns())return;
        pending.current?.abort();const controller=new AbortController();pending.current=controller;
        const defaultBytes=quotaBytes(draft.defaultMiB),maximumBytes=quotaBytes(draft.maximumMiB);
        busy.current=true;setSaving(true);setError('');const request=++epoch.current;
        try {
            const value=requirePlatformQuota((await base.patch<unknown>(path,{defaultBytes,maximumBytes,expectedRevision:revision.current},{signal:controller.signal,timeout:15000})).data);
            if(!owns()||request!==epoch.current)return;
            if(value.defaultBytes!==defaultBytes||value.maximumBytes!==maximumBytes)throw new Error('Сервер не подтвердил выбранные значения.');
            edited.current=false;setDirty(false);revision.current=value.revision;setPolicy(value);
            form.setFieldsValue({defaultMiB:value.defaultBytes/MIB,maximumMiB:value.maximumBytes/MIB});
        }catch(failure){if(!controller.signal.aborted&&owns()&&request===epoch.current)setError(errorMessage(failure,'Настройки не сохранены. Черновик остался в форме.'));}
        finally{busy.current=false;if(owns()&&request===epoch.current)setSaving(false);}
    };
    const numberRule={validator:(_:unknown,value:unknown)=>{try{quotaBytes(value);return Promise.resolve();}catch(failure){return Promise.reject(failure);}}};
    return <Card title="Квоты баз знаний" extra={<Button loading={loading} disabled={saving} onClick={()=>void load(true)}>Обновить сведения</Button>}>
        <Typography.Paragraph type="secondary">Начальный лимит применяется к новым базам знаний. Максимум ограничивает новые значения проектных лимитов. Уже установленные лимиты и сохранённые знания остаются на месте.</Typography.Paragraph>
        {error&&<Alert showIcon type="error" message="Настройки требуют проверки" description={error}/>}
        {!policy?loading?<Spin tip="Загружаем настройки…"/>:null:<Form form={form} layout="vertical" onValuesChange={()=>{edited.current=true;setDirty(true);}} onFinish={draft=>void save(draft)}>
            <Space align="start" wrap>
                <Form.Item name="defaultMiB" label="Начальный лимит (МиБ)" rules={[{required:true,message:'Укажите лимит.'},numberRule]}>
                    <InputNumber min={1/MIB} max={Number.MAX_SAFE_INTEGER/MIB} disabled={saving}/>
                </Form.Item>
                <Form.Item name="maximumMiB" label="Максимум проектного лимита (МиБ)" dependencies={['defaultMiB']} rules={[{required:true,message:'Укажите максимум.'},numberRule,
                    {validator:(_,value)=>value>=form.getFieldValue('defaultMiB')?Promise.resolve():Promise.reject(new Error('Максимум не может быть меньше начального лимита.'))}]}>
                    <InputNumber min={1/MIB} max={Number.MAX_SAFE_INTEGER/MIB} disabled={saving}/>
                </Form.Item>
            </Space>
            <Typography.Paragraph type="secondary">1 ГиБ = 1024 МиБ. Настройки сохраняются на сервере и переживают перезапуск.</Typography.Paragraph>
            <Button type="primary" htmlType="submit" loading={saving} disabled={!dirty||loading||!!error}>Сохранить настройки квот</Button>
        </Form>}
    </Card>;
}

/** Role-scoped mounting discards drafts and stale results after account or active-role changes. */
export function RagQuotaPolicy():JSX.Element|null {
    const {user,policies}=useSelector((state:RootState)=>state.userBlock);
    if(!user||user.activeRole!=='Главный админ'||!user.userRoles.includes(user.activeRole))return null;
    return <QuotaPolicyForm key={authDataScope({user,policies})}/>;
}
