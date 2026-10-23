import {ReloadOutlined,SearchOutlined} from '@ant-design/icons';
import {Alert,Button,Card,Empty,Input,List,Pagination,Typography} from 'antd';
import {useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {authDataScope} from '../UserBlock/authDataScope';
import {PurgePreview} from './PurgePreview';
import {useRetiredRagDatabases} from './useRetiredRagDatabases';
import {RetiredRagRow} from './RetiredRagRow';
import {retiredRagPage,retiredRagStatus,type TRetiredRagFilter} from './presentation';
import './RetiredRagDatabases.less';

function AccountRetiredRagDatabases(){
    const state=useRetiredRagDatabases();
    const [query,setQuery]=useState(''),[filter,setFilter]=useState<TRetiredRagFilter>('all'),[page,setPage]=useState(1);
    const visible=retiredRagPage(state.items,query,filter,page),deleted=state.items.filter(row=>retiredRagStatus(row).purged).length;
    const filters:Array<{key:TRetiredRagFilter;label:string;count:number}>=[{key:'all',label:'Все',count:state.items.length},
        {key:'retained',label:'На хранении',count:state.items.length-deleted},{key:'deleted',label:'Удалённые',count:deleted}];
    return <Card className="retired-rag" title="RAG-базы удалённых проектов" extra={<Button icon={<ReloadOutlined/>} loading={state.loading} disabled={state.busy} onClick={()=>void state.refresh()}>Обновить</Button>}>
        <Typography.Paragraph className="retired-rag__intro" type="secondary">Базы знаний сохраняются после удаления проекта и входят в полную резервную копию сервера. Автоматическое удаление выключено.</Typography.Paragraph>
        {state.error&&<Alert type="error" showIcon message="Действие не подтверждено" description={state.error} className="retired-rag__error"/>}
        <div className="retired-rag__toolbar">
            <div role="group" aria-label="Состояние RAG-баз" className="retired-rag__filters">{filters.map(item=><Button key={item.key} size="small" type={filter===item.key?'primary':'default'} aria-pressed={filter===item.key}
                onClick={()=>{setFilter(item.key);setPage(1);}}>{item.label}<span className="retired-rag__count">{item.count}</span></Button>)}</div>
            <Input className="retired-rag__search" prefix={<SearchOutlined/>} placeholder="Найти проект или базу" aria-label="Поиск сохранённых RAG-баз" allowClear value={query} onChange={event=>{setQuery(event.target.value);setPage(1);}}/>
        </div>
        <List split={false} loading={state.loading&&!state.items.length} dataSource={visible.items} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={state.items.length?'По этим условиям базы не найдены':'Сохранённых RAG-баз пока нет'}/>}}
            renderItem={row=><List.Item key={row.id}><RetiredRagRow row={row} busy={state.busy} onOpen={()=>void state.open(row)} onRetry={()=>void state.retry(row)} onRetention={(date,reason)=>void state.retention(row,date,reason)}/></List.Item>}/>
        {visible.total>0&&<div className="retired-rag__pagination"><Typography.Text type="secondary">{(visible.page-1)*visible.pageSize+1}–{Math.min(visible.page*visible.pageSize,visible.total)} из {visible.total}</Typography.Text>
            <Pagination size="small" current={visible.page} pageSize={visible.pageSize} total={visible.total} showSizeChanger={false} hideOnSinglePage onChange={setPage}/></div>}
        <PurgePreview plan={state.preview} busy={state.busy} onClose={state.close} onPurge={()=>void state.purge()}/>
    </Card>;
}
/** Полный auth scope не позволяет позднему preview пережить смену владельца или прав. */
export default function RetiredRagDatabases(){const {user,policies}=useSelector((state:RootState)=>state.userBlock);if(!user||user.activeRole!=='Главный админ')return null;return <AccountRetiredRagDatabases key={authDataScope({user,policies})}/>;}
