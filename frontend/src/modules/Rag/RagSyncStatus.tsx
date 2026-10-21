import {ClockCircleOutlined,DatabaseOutlined} from '@ant-design/icons';
import {Button,Tooltip} from 'antd';

/** Stored fragments describe delivery state; they do not claim a model or index verification. */
export function RagSyncStatus({hasFragments}:{hasFragments:boolean}):JSX.Element {
    const label=hasFragments?'На сервере есть фрагменты знаний':'Знания ещё не синхронизированы';
    return <Tooltip trigger={['hover','focus','click']} title={hasFragments?'Серверная копия содержит фрагменты проекта. Готовность индекса и модель проверяются в знаниях проекта.':'В серверной копии пока нет фрагментов. Откройте знания проекта, чтобы подготовить индекс и синхронизировать его.'}>
        <Button type="text" size="small" aria-label={label} title={label} icon={hasFragments?<DatabaseOutlined style={{color:'#3d6082'}}/>:<ClockCircleOutlined style={{color:'#ad6800'}}/>}/>
    </Tooltip>;
}
