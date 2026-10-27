import {Alert, Button, Spin, Typography} from 'antd';
import {useEffect, useRef, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {agentToolsApi} from './api';
import {AgentToolsGrantSummary} from './AgentToolsControls';
import type {AgentToolGrant, AgentToolStep} from './types';
import {ReadOutlined, SearchOutlined, ToolOutlined} from '@ant-design/icons';
import {ChatActivityGroup} from '../ChatCommon/ChatActivityGroup';
const actionNames: Record<string,string> = {rag_search: 'Поиск в базе знаний',rag_read: 'Чтение найденного источника',public_chat_search: 'Поиск публичных чатов',request_system_role: 'Системная справка и диагностика'};
const stateNames: Record<AgentToolStep['state'],string> = {queued: 'В очереди',dispatched: 'Запущено',succeeded: 'Результат сохранён',failed: 'Не выполнено',unknown: 'Исход не подтверждён · автоматический повтор закрыт',cancelled: 'Отменено'};
/** Saved read-only receipts are always reachable, including OFF and unknown execution outcomes. */
export function AgentToolHistory({projectId,turnId,grant}: {projectId: string; turnId: string; grant: AgentToolGrant}): JSX.Element {
    const {scope,captureOwner} = useAuthRequestOwner(), owner = JSON.stringify([scope,projectId,turnId]);
    const live = useRef(owner); live.current = owner;
    const [open,setOpen] = useState(false), [revision,setRevision] = useState(0), [state,setState] = useState<{owner: string; loading: boolean; error?: string; steps?: AgentToolStep[]}>({owner,loading: false});
    useEffect(() => {
        if (!open) return;
        const abort = new AbortController(), owns = captureOwner(); setState({owner,loading: true});
        void agentToolsApi.steps(projectId,turnId,abort.signal).then(steps => {if (owns() && !abort.signal.aborted && live.current === owner) setState({owner,loading: false,steps});})
            .catch(cause => {if (owns() && !abort.signal.aborted && live.current === owner) setState({owner,loading: false,error: errorMessage(cause,'История шагов пока недоступна. Повторите чтение; новая работа не запускается.')});});
        return () => abort.abort();
    }, [open,owner,revision]);
    const value = state.owner === owner ? state : undefined;
    return <ChatActivityGroup label="Контекст и шаги инструментов" onToggle={event => setOpen(event.currentTarget.open)}><AgentToolsGrantSummary grant={grant}/>
        {open && <>{value?.loading && <Spin size="small"/>}{value?.error && <Alert type="warning" showIcon message={value.error}/>}
            {value?.steps?.map(step => <Step key={step.id} step={step} owner={owner}/>)}
            {!value?.loading && !value?.error && !value?.steps?.length && <Typography.Paragraph type="secondary">Сохранённых шагов пока нет. Подробности доступны инициатору запроса.</Typography.Paragraph>}
            <Button size="small" disabled={value?.loading} onClick={() => setRevision(value => value + 1)}>Обновить историю шагов</Button></>}
    </ChatActivityGroup>;
}
function Step({step,owner}: {step: AgentToolStep; owner: string}): JSX.Element {
    const {captureOwner} = useAuthRequestOwner(), live = useRef(owner); live.current = owner;
    const [open,setOpen] = useState(false), [result,setResult] = useState<{owner: string; value?: AgentToolStep; error?: string}>();
    useEffect(() => {
        if (!open) return;
        const abort = new AbortController(), owns = captureOwner(); setResult(undefined);
        void agentToolsApi.step(step.id,abort.signal).then(value => {if (owns() && !abort.signal.aborted && live.current === owner) setResult({owner,value});})
            .catch(cause => {if (owns() && !abort.signal.aborted && live.current === owner) setResult({owner,error: errorMessage(cause,'Результат недоступен. Проверьте текущий доступ к исходному чату.')});});
        return () => abort.abort();
    }, [open,owner,step.id,step.state,step.updated_at]);
    const detail = result?.owner === owner ? result : undefined;
    const icon = step.action === 'rag_read' ? <ReadOutlined/> : step.action.endsWith('_search') ? <SearchOutlined/> : <ToolOutlined/>;
    return <ChatActivityGroup icon={icon} label={<>{step.sequence}. {actionNames[step.action] ?? 'Шаг инструмента'} · {stateNames[step.state]}</>} onToggle={event => setOpen(event.currentTarget.open)}>
        {step.error && <Typography.Paragraph type="warning">{step.error}</Typography.Paragraph>}
        {open && (detail?.error ? <Alert type="warning" message={detail.error}/> : detail?.value ? <><Typography.Text type="secondary">Исполнитель: {step.agent_id ?? 'выбранная модель'} · {step.model_id}</Typography.Text><pre style={{whiteSpace: 'pre-wrap',overflowWrap: 'anywhere'}}>{JSON.stringify({input: detail.value.input,output: detail.value.output,reference: detail.value.reference},null,2)}</pre></> : <Spin size="small"/>)}
    </ChatActivityGroup>;
}
