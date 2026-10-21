import {Alert,Button,Space,Typography} from 'antd';
import {snapshotActionLabel} from './types';
import type {useSnapshotIntent} from './useSnapshotIntent';
/** Unknown responses remain actionable by their original UUID until server cancellation or receipt recovery. */
export function SnapshotIntentStatus({state,canWrite}:{state:ReturnType<typeof useSnapshotIntent>;canWrite:boolean}){
    return <>
        {state.error&&<Alert type="warning" showIcon message="Запрос снимка требует проверки" description={state.error}/>}
        {state.notice&&<Alert type="info" showIcon message={state.notice}/>}
        {state.intent&&<Alert type="warning" showIcon message={state.receipt?'Запрос подтверждён, локальное подтверждение ещё не закрыто':'Сохранён незавершённый запрос'} description={<Space direction="vertical" size={8} style={{width:'100%'}}>
            <Typography.Text>{snapshotActionLabel[state.intent.kind]}. Новые действия заблокированы до проверки или подтверждённой отмены этого запроса.</Typography.Text>
            <Typography.Text code className="project-snapshots__identity">{state.intent.input.requestKey}</Typography.Text>
            {state.intent.kind==='create'&&<Typography.Text type="secondary">Компьютер: {state.intent.input.deviceId}</Typography.Text>}
            {state.missing&&<Typography.Text>Сервер пока не нашёл квитанцию. Это ещё не подтверждение отмены: запоздалый запрос может находиться в пути.</Typography.Text>}
            <Space wrap>
                <Button disabled={state.busy||state.loading} onClick={()=>{void state.refresh();}}>Проверить запрос</Button>
                {!state.receipt&&<Button disabled={!canWrite||state.busy||state.loading||state.blocked} onClick={()=>{void state.repeat();}}>Повторить сохранённый запрос</Button>}
                <Button disabled={!canWrite||state.busy||state.loading} onClick={()=>{void state.abandon();}}>{state.receipt?'Закрыть подтверждение':'Отменить сохранённый запрос'}</Button>
            </Space>
        </Space>}/>}
        {state.blocked&&!state.intent&&<Button disabled={state.busy||state.loading} onClick={()=>{void state.refresh();}}>Проверить хранилище подтверждений</Button>}
    </>;
}
