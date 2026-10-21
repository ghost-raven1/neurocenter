import {Alert,Descriptions,Input,Modal,Space,Typography} from 'antd';
import {useEffect,useState} from 'react';
import {formatBytes} from '../../common/utils/format';
import type {IRetiredRagPreview} from './types';

/** Необратимый DROP требует подтверждения точного проекта после показа физической identity и impact. */
export function PurgePreview({plan,busy,onClose,onPurge}:{plan:IRetiredRagPreview|null;busy:boolean;onClose:()=>void;onPurge:()=>void}){
    const [confirmation,setConfirmation]=useState('');useEffect(()=>setConfirmation(''),[plan?.id]);if(!plan)return null;
    const expired=Date.parse(plan.expiresAt)<=Date.now();
    return <Modal title="Удаление сохранённой RAG-базы" open onCancel={onClose} onOk={onPurge} okText="Удалить RAG-базу" cancelText="Сохранить базу"
        confirmLoading={busy} closable={!busy} maskClosable={!busy} cancelButtonProps={{disabled:busy}} okButtonProps={{danger:true,disabled:busy||expired||confirmation!==plan.projectName}}>
        <Space direction="vertical" size="middle" style={{width:'100%',overflowWrap:'anywhere'}}>
            <Alert type="warning" showIcon message="Это необратимо для действующего сервера" description={plan.warning}/>
            <Descriptions column={1} size="small">
                <Descriptions.Item label="Удалённый проект">{plan.projectName}</Descriptions.Item>
                <Descriptions.Item label="ID проекта">{plan.facts.identity.projectId}</Descriptions.Item>
                <Descriptions.Item label="Физическая база"><Typography.Text code>{plan.facts.identity.databaseName}</Typography.Text></Descriptions.Item>
                <Descriptions.Item label="Данные">{formatBytes(plan.facts.bytes)} · {plan.facts.chunks} фрагментов · {plan.facts.generations} поколений</Descriptions.Item>
                <Descriptions.Item label="Кластер / OID">{plan.facts.identity.cluster} / {plan.facts.identity.oid}</Descriptions.Item>
                <Descriptions.Item label="Identity">{plan.facts.identity.marker}</Descriptions.Item>
                <Descriptions.Item label="SHA-256 плана"><Typography.Text code>{plan.digest}</Typography.Text></Descriptions.Item>
            </Descriptions>
            <Typography.Text type="secondary">Квитанция относится к этой базе и этому объёму данных. При изменении состояния сервер отклонит удаление.</Typography.Text>
            {expired&&<Alert type="error" message="План истёк. Закройте окно и подготовьте новый."/>}
            <label>Для подтверждения введите название проекта: <strong>{plan.projectName}</strong><Input aria-label="Название проекта для удаления RAG-базы" autoComplete="off" value={confirmation} disabled={busy} onChange={event=>setConfirmation(event.target.value)}/></label>
        </Space>
    </Modal>;
}
