import {DatabaseOutlined,DownOutlined,DeleteOutlined} from '@ant-design/icons';
import {Alert,Button,Input,Space,Tag,Typography} from 'antd';
import {useState} from 'react';
import {formatBytes} from '../../common/utils/format';
import {retiredRagStatus} from './presentation';
import type {IRetiredRagDatabase} from './types';

function Retention({row,busy,onSave}:{row:IRetiredRagDatabase;busy:boolean;onSave:(date:string|null,reason:string)=>void}){
    const [date,setDate]=useState(''),[reason,setReason]=useState(''),[editing,setEditing]=useState(false);
    if(!editing)return <Button size="small" disabled={busy} onClick={()=>setEditing(true)}>Настроить удержание</Button>;
    return <Space wrap className="retired-rag__retention">
        <Input type="datetime-local" aria-label="Удерживать RAG-базу до" value={date} onChange={event=>setDate(event.target.value)} disabled={busy}/>
        <Input aria-label="Причина удержания RAG-базы" placeholder="Причина удержания" value={reason} maxLength={500} onChange={event=>setReason(event.target.value)} disabled={busy}/>
        <Button size="small" disabled={busy||!date||!Number.isFinite(Date.parse(date))||Date.parse(date)<=Date.now()} onClick={()=>onSave(new Date(date).toISOString(),reason)}>Удерживать до даты</Button>
        {row.retention.retainUntil&&<Button size="small" disabled={busy} onClick={()=>onSave(null,reason)}>Снять удержание</Button>}
        <Button size="small" type="text" disabled={busy} onClick={()=>setEditing(false)}>Закрыть</Button>
    </Space>;
}
interface IProps {row:IRetiredRagDatabase;busy:boolean;onOpen:()=>void;onRetry:()=>void;onRetention:(date:string|null,reason:string)=>void;}

/** Completed receipts are available on demand; warnings and unfinished operations stay visible. */
export function RetiredRagRow({row,busy,onOpen,onRetry,onRetention}:IProps){
    const {pending,anomaly,purged,missing,label,color}=retiredRagStatus(row);
    return <article className={`retired-rag__row${purged?' retired-rag__row--deleted':''}`}>
        <div className="retired-rag__row-heading">
            <span className="retired-rag__icon" aria-hidden="true"><DatabaseOutlined/></span>
            <div className="retired-rag__identity">
                <Typography.Text strong className="retired-rag__name">{row.projectName}</Typography.Text>
                <Typography.Text type="secondary" className="retired-rag__meta">{row.database?.present?`${formatBytes(row.database.bytes)} · `:''}учтена с {new Date(row.deletedAt).toLocaleDateString('ru-RU')}</Typography.Text>
            </div>
            <Tag color={color}>{label}</Tag>
        </div>
        {anomaly&&<Alert type="warning" showIcon message="После подтверждённого удаления появилась новая физическая база. Она сохранена; прежняя квитанция не разрешает её удаление."/>}
        {missing&&<Alert type="warning" showIcon message="Физическая база отсутствует, но квитанции удаления нет. Проверьте сервер или резервную копию; удаление не подтверждено."/>}
        {row.job&&row.job.state!=='succeeded'&&<div className="retired-rag__operation">
            {row.job.state==='failed'?<Alert type="error" showIcon message={row.job.message}/>:<Typography.Text role="status">{row.job.message}</Typography.Text>}
            {row.job.state==='failed'&&!purged&&<Button size="small" disabled={busy||!!row.blockers.length} onClick={onRetry}>Повторить удаление</Button>}
        </div>}
        <details className="retired-rag__details">
            <summary>Подробности{!purged?' и управление':''}<DownOutlined aria-hidden="true"/></summary>
            <div className="retired-rag__details-content">
                <Typography.Text type="secondary" className="retired-rag__database">{row.database?.databaseName??'Отдельная RAG-база не создавалась'}</Typography.Text>
                <Typography.Text type="secondary">Проект: {row.projectId} · учтена с {new Date(row.deletedAt).toLocaleString('ru-RU')}</Typography.Text>
                {!purged&&<Typography.Text>Хранение: {row.retention.retainUntil?`удерживать до ${new Date(row.retention.retainUntil).toLocaleString('ru-RU')}`:'до явного удаления'}{row.retention.reason?` · ${row.retention.reason}`:''}</Typography.Text>}
                {!!row.blockers.length&&!purged&&<Alert type="info" showIcon message={row.blockers.join(' ')}/>}
                {row.job?.state==='succeeded'&&<Typography.Text type="secondary" className="retired-rag__receipt">Квитанция: {row.job.message}</Typography.Text>}
                {!purged&&<Space wrap className="retired-rag__actions">
                    <Button danger size="small" icon={<DeleteOutlined/>} disabled={busy||pending||anomaly||!row.database?.present||!!row.blockers.length} onClick={onOpen}>Проверить и удалить</Button>
                    <Retention key={row.retention.revision} row={row} busy={busy||pending} onSave={onRetention}/>
                </Space>}
            </div>
        </details>
    </article>;
}
