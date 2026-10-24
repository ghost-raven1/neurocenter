import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import {Alert,Button,Progress,Space,Typography} from 'antd';
import type {useProjectReindex} from './useProjectReindex';

interface IProps {state:ReturnType<typeof useProjectReindex>;canManage:boolean;}
/** Подтверждение требуется только для перестройки существующих данных; пустой проект переключается автоматически. */
export function ProjectReindexStatus({state,canManage}:IProps):JSX.Element|null{
    const plan=state.plan;
    if(!plan&&!state.error)return null;
    const confirm=plan?.state==='needs_input',localFailed=plan?.local&&['failed','cancelled'].includes(plan.local.state),failed=plan&&(['failed','stale'].includes(plan.state)||localFailed);
    return <Space direction="vertical" size={8} style={{width:'100%'}}>
        {state.error&&<Alert type="error" showIcon message={state.error}/>}
        {plan&&<Alert showIcon type={failed?'warning':plan.state==='applied'&&!state.pending?'success':'info'} message={plan.local&&plan.state==='applied'?plan.local.message:plan.message}
            description={<Space direction="vertical" size={8} style={{width:'100%'}}>
                {plan.state==='applied'&&!plan.data.connection&&<Typography.Text type="secondary">Этот результат относится к серверному индексу. OpenCodeRAG на компьютере подключается отдельно.</Typography.Text>}
                {plan.data.connection&&<Typography.Text type="secondary">{plan.state==='applied'&&plan.local?.state==='succeeded'
                    ?'Локальный индекс проверен и синхронизирован. Перезапустите OpenCode, чтобы открытая сессия использовала новое подключение.'
                    :'Включено подключение и полная переиндексация выбранной установки OpenCodeRAG. Прежний локальный индекс сохранится до проверки нового.'}</Typography.Text>}
                {confirm&&<Typography.Text>Будут заново вычислены векторы для {plan.data.rowCount} фрагментов. Оценка дополнительного места: {(plan.data.requiredBytes/1024**2).toFixed(1)} МиБ. Прежнее поколение сохранится.</Typography.Text>}
                {state.pending&&<Progress percent={plan.state==='applied'&&plan.local?plan.local.percent??0:plan.progress} size="small" status="active"/>}
                {canManage&&<Space wrap>
                    {confirm&&<FeatureButton features={['rag_sync','model_hosting']} type="primary" loading={state.busy} onClick={()=>{void state.start();}}>Перестроить и подключить</FeatureButton>}
                    {localFailed&&<FeatureButton features={['rag_sync','model_hosting']} loading={state.busy} onClick={()=>{void state.retryLocal();}}>Повторить подключение компьютера</FeatureButton>}
                    {plan.state==='failed'&&<FeatureButton features={['rag_sync','model_hosting']} loading={state.busy} onClick={()=>{void state.retry();}}>Повторить</FeatureButton>}
                    {!['applied','cancelled','cancelling'].includes(plan.state)&&<Button disabled={state.busy} onClick={()=>{void state.cancel();}}>Отменить</Button>}
                </Space>}
            </Space>}/>}
    </Space>;
}
