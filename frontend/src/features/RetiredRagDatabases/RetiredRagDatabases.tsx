import {DeleteOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Card,Empty,Input,List,Space,Tag,Typography} from 'antd';
import {useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {authDataScope} from '../UserBlock/authDataScope';
import {formatBytes} from '../../common/utils/format';
import {PurgePreview} from './PurgePreview';
import {useRetiredRagDatabases} from './useRetiredRagDatabases';
import type {IRetiredRagDatabase} from './types';
import './RetiredRagDatabases.less';

function Retention({row,busy,onSave}:{row:IRetiredRagDatabase;busy:boolean;onSave:(date:string|null,reason:string)=>void}){
    const [date,setDate]=useState(''),[reason,setReason]=useState(''),[editing,setEditing]=useState(false);
    if(!editing)return <Button size="small" disabled={busy} onClick={()=>setEditing(true)}>Настроить удержание</Button>;
    return <Space wrap>
        <Input type="datetime-local" aria-label="Удерживать RAG-базу до" value={date} onChange={event=>setDate(event.target.value)} disabled={busy} style={{maxWidth:230}}/>
        <Input aria-label="Причина удержания RAG-базы" placeholder="Причина удержания" value={reason} maxLength={500} onChange={event=>setReason(event.target.value)} disabled={busy} style={{maxWidth:270}}/>
        <Button size="small" disabled={busy||!date||!Number.isFinite(Date.parse(date))||Date.parse(date)<=Date.now()} onClick={()=>onSave(new Date(date).toISOString(),reason)}>Удерживать до даты</Button>
        {row.retention.retainUntil&&<Button size="small" disabled={busy} onClick={()=>onSave(null,reason)}>Снять удержание</Button>}
        <Button size="small" type="text" disabled={busy} onClick={()=>setEditing(false)}>Закрыть</Button>
    </Space>;
}
function AccountRetiredRagDatabases(){
    const state=useRetiredRagDatabases();
    return <Card className="retired-rag" title="RAG-базы удалённых проектов" extra={<Button icon={<ReloadOutlined/>} loading={state.loading} disabled={state.busy} onClick={()=>void state.refresh()}>Обновить</Button>}>
        <Typography.Paragraph>Удаление проекта сохраняет его серверную базу знаний. Она хранится до явного решения главного администратора и входит в полную резервную копию сервера. Автоматическое удаление выключено.</Typography.Paragraph>
        {state.error&&<Alert type="error" showIcon message="Действие не подтверждено" description={state.error} style={{marginBottom:16}}/>}
        <List loading={state.loading&&!state.items.length} dataSource={state.items} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Сохранённых RAG-баз пока нет"/>}}
            renderItem={row=>{const pending=!!row.job&&['queued','running'].includes(row.job.state),anomaly=row.database?.state==='purged'&&row.database.present,purged=!row.database?.present&&(row.database?.state==='purged'||row.job?.state==='succeeded'),missing=!!row.database&&!row.database.present&&!purged;return <List.Item key={row.id} style={{display:'block',overflowWrap:'anywhere'}}>
                <Space direction="vertical" style={{width:'100%'}} size="small">
                    <Space wrap><Typography.Text strong>{row.projectName}</Typography.Text><Tag color={anomaly||missing?'warning':purged?'default':pending?'processing':'blue'}>{anomaly?'Требует проверки':purged?'Удалена':missing?'База отсутствует':pending?'Удаление проверяется':'Сохранена'}</Tag></Space>
                    <Typography.Text type="secondary">{row.database?.databaseName??'Отдельная RAG-база не создавалась'}{row.database?.present?` · ${formatBytes(row.database.bytes)}`:''} · учтена с {new Date(row.deletedAt).toLocaleString('ru-RU')}</Typography.Text>
                    {!purged&&<Typography.Text>Хранение: {row.retention.retainUntil?`удерживать до ${new Date(row.retention.retainUntil).toLocaleString('ru-RU')}`:'до явного удаления'}{row.retention.reason?` · ${row.retention.reason}`:''}</Typography.Text>}
                    {!!row.blockers.length&&!purged&&<Alert type="info" showIcon message={row.blockers.join(' ')}/>}
                    {anomaly&&<Alert type="warning" showIcon message="После подтверждённого удаления появилась новая физическая база. Она сохранена; прежняя квитанция не разрешает её удаление."/>}
                    {missing&&<Alert type="warning" showIcon message="Физическая база отсутствует, но квитанции удаления нет. Проверьте сервер или резервную копию; удаление не подтверждено."/>}
                    {row.job&&<Alert type={row.job.state==='failed'?'error':row.job.state==='succeeded'?'success':'info'} showIcon message={row.job.message}/>}
                    {!purged&&<Space wrap>
                        <Button danger icon={<DeleteOutlined/>} disabled={state.busy||pending||anomaly||!row.database?.present||!!row.blockers.length} onClick={()=>void state.open(row)}>Проверить и удалить</Button>
                        {row.job?.state==='failed'&&<Button disabled={state.busy||!!row.blockers.length} onClick={()=>void state.retry(row)}>Повторить удаление</Button>}
                        <Retention key={row.retention.revision} row={row} busy={state.busy||pending} onSave={(date,reason)=>void state.retention(row,date,reason)}/>
                    </Space>}
                </Space>
            </List.Item>;}}/>
        <PurgePreview plan={state.preview} busy={state.busy} onClose={state.close} onPurge={()=>void state.purge()}/>
    </Card>;
}
/** Полный auth scope не позволяет позднему preview пережить смену владельца или прав. */
export default function RetiredRagDatabases(){const {user,policies}=useSelector((state:RootState)=>state.userBlock);if(!user||user.activeRole!=='Главный админ')return null;return <AccountRetiredRagDatabases key={authDataScope({user,policies})}/>;}
