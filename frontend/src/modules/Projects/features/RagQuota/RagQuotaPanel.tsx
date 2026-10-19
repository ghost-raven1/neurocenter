import {Alert,Button,Card,Col,Form,InputNumber,message,Progress,Row,Space,Spin,Tag,Typography} from 'antd';
import {useEffect,useRef,useState} from 'react';
import bffApi from '../../../../core/api/bff';
import {errorMessage} from '../../../../common/utils/errorMessage';
import {formatRagBytes,MEBIBYTE,ragLimitBytes,ragQuotaPercent,requireRagQuota} from './model';
import {useRagQuota} from './useRagQuota';
import './RagQuota.less';
const {Text,Paragraph,Title}=Typography;

/** Действующий лимит знаний; черновик и его ревизия переживают фоновые обновления. */
export default function RagQuotaPanel({projectKey}:{projectKey:string}):JSX.Element{
    const {quota,loading,error,refresh,accept,captureCurrent}=useRagQuota(projectKey);const [form]=Form.useForm<{limitMiB:number}>();
    const [dirty,setDirty]=useState(false);const [saving,setSaving]=useState(false);const [saveError,setSaveError]=useState('');
    const draftRevision=useRef<number|null>(null);const edited=useRef(false);const busy=useRef(false);
    useEffect(()=>{edited.current=false;busy.current=false;draftRevision.current=null;setDirty(false);setSaving(false);setSaveError('');},[captureCurrent]);
    useEffect(()=>{if(quota&&!edited.current){form.setFieldsValue({limitMiB:quota.limitBytes/MEBIBYTE});draftRevision.current=quota.revision;}},[quota,form]);
    const review=async():Promise<void>=>{const isCurrent=captureCurrent();if(!isCurrent()){return;}const fresh=await refresh();if(fresh&&isCurrent()){draftRevision.current=fresh.revision;setSaveError('');}};
    const save=async(values:{limitMiB:number}):Promise<void>=>{
        const isCurrent=captureCurrent();
        if(!isCurrent()||busy.current||!quota||draftRevision.current===null){return;}busy.current=true;setSaving(true);setSaveError('');
        try{
            const limitBytes=ragLimitBytes(values.limitMiB,Math.max(quota.maximumBytes,quota.limitBytes));
            const saved=requireRagQuota(await bffApi.updateRagQuota(projectKey,{limitBytes,expectedRevision:draftRevision.current}));
            if(!isCurrent()){return;}
            if(saved.limitBytes!==limitBytes){throw new Error('Сервер не подтвердил новый лимит. Обновите сведения и повторите сохранение.');}
            edited.current=false;setDirty(false);accept(saved);draftRevision.current=saved.revision;form.setFieldsValue({limitMiB:saved.limitBytes/MEBIBYTE});void message.success('Лимит базы знаний сохранён');void refresh();
        }catch(failure){if(isCurrent()){setSaveError(errorMessage(failure,'Не удалось сохранить лимит. Введённое значение осталось в форме.'));}}
        finally{if(isCurrent()){busy.current=false;setSaving(false);}}
    };
    return <Space direction="vertical" size={16} className="rag-quota">
        <Card className="rag-quota-card" title="Лимит базы знаний" extra={<Button onClick={()=>void review()} loading={loading} disabled={saving}>Обновить сведения</Button>}>
            {error&&<Alert showIcon type="warning" message={quota?'Не удалось обновить сведения — показаны последние данные':'Сведения о лимите недоступны'} description={error} />}
            {!quota?loading?<Spin tip="Загружаем лимит…" />:null:<Row gutter={[32,24]}>
                <Col xs={24} md={12}>
                    <Tag color="green">Защита включена</Tag>
                    <Title level={3}>{formatRagBytes(quota.usedBytes)} <Text type="secondary">из {formatRagBytes(quota.limitBytes)}</Text></Title>
                    <Progress percent={ragQuotaPercent(quota)} status={quota.availableBytes===0?'exception':'normal'} />
                    <Paragraph>Доступно для новых знаний: <Text strong>{formatRagBytes(quota.availableBytes)}</Text>.</Paragraph>
                    {quota.availableBytes===0&&<Alert showIcon type="warning" message="Лимит достигнут" description="Уменьшите объём знаний или увеличьте лимит. Просмотр, скачивание и удаление остаются доступны." />}
                </Col>
                <Col xs={24} md={12}>
                    <Form form={form} layout="vertical" onFinish={values=>void save(values)} onValuesChange={()=>{edited.current=true;setDirty(true);setSaveError('');}}>
                        <Form.Item name="limitMiB" label="Новый лимит (МиБ)" extra={`1 ГиБ = 1024 МиБ. Максимум для нового лимита: ${formatRagBytes(quota.maximumBytes)}.`} validateFirst rules={[{required:true,message:'Укажите лимит.'},{validator:(_,value)=>{try{ragLimitBytes(value,Math.max(quota.maximumBytes,quota.limitBytes));return Promise.resolve();}catch(failure){return Promise.reject(failure);}}}]}>
                            <InputNumber inputMode="decimal" min={1/MEBIBYTE} max={Math.max(quota.maximumBytes,quota.limitBytes)/MEBIBYTE} step={256} disabled={saving} className="rag-quota__input" />
                        </Form.Item>
                        <Button type="primary" htmlType="submit" loading={saving} disabled={!dirty||!!error||loading}>Сохранить лимит</Button>
                    </Form>
                    {saveError&&<Alert className="rag-quota__error" showIcon type="error" message="Лимит не сохранён" description={saveError} action={<Button size="small" onClick={()=>void review()} disabled={saving}>Обновить сведения</Button>} />}
                </Col>
            </Row>}
        </Card>
        <Alert type="info" showIcon message="Что входит в этот лимит" description="Учитываются тексты, метаданные и векторы в серверной базе знаний. При превышении весь пакет синхронизации отменяется. Физический размер PostgreSQL, файлы скиллов, локальная LanceDB и резервные копии считаются отдельно." />
    </Space>;
}
