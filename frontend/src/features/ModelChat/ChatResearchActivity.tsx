import {Alert, Button, Spin, Typography} from 'antd';
import {useEffect, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {modelChatApi} from './api';
import type {IChatResearchStep, IChatResearchStepSummary} from './types';
import {ReadOutlined, SearchOutlined, UnorderedListOutlined} from '@ant-design/icons';
import {ChatActivityGroup} from '../ChatCommon/ChatActivityGroup';

const names = {planner: 'Выбор следующего шага', project_search: 'Поиск по проекту', project_read: 'Чтение фрагмента проекта', external_search: 'Внешний поиск', external_fetch: 'Чтение внешних страниц'};
const statuses = {pending: 'Выполняется', done: 'Готово', failed: 'Ошибка', cancelled: 'Остановлено'};

/** Large private results load only when the owner explicitly opens one saved step. */
export function ChatResearchStep({step, conversationId}: {step: IChatResearchStepSummary; conversationId: string}): JSX.Element {
    const {captureOwner} = useAuthRequestOwner();
    const [open, setOpen] = useState(false), [value, setValue] = useState<IChatResearchStep>(), [error, setError] = useState(''), [revision, setRevision] = useState(0);
    useEffect(() => {
        if (!open) return;
        const abort = new AbortController(), owns = captureOwner(); setError(''); setValue(undefined);
        void modelChatApi.researchStep(conversationId, step.id, abort.signal)
            .then(result => {if (owns() && !abort.signal.aborted) setValue(result);})
            .catch(cause => {if (owns() && !abort.signal.aborted) setError(errorMessage(cause, 'Не удалось открыть сохранённый шаг.'));});
        return () => abort.abort();
    }, [open, conversationId, step.id, step.updatedAt, revision, captureOwner]);
    const icon = step.kind === 'planner' ? <UnorderedListOutlined/> : step.kind.endsWith('_search') ? <SearchOutlined/> : <ReadOutlined/>;
    return <ChatActivityGroup icon={icon} label={<>{step.sequence}. {names[step.kind]} · {statuses[step.status]}{step.attempt > 1 ? ` · попытка ${step.attempt}` : ''}</>} onToggle={event => setOpen(event.currentTarget.open)}>
        {open && <div className="model-chat__research-step">{error ? <><Alert type="error" message={error}/><Button size="small" onClick={() => setRevision(revision + 1)}>Повторить загрузку шага</Button></> : !value ? <Spin size="small"/> : <>
            {value.error && <Typography.Text type="warning">{value.error}</Typography.Text>}
            {!!Object.keys(value.input).filter(key => !['modelId', 'modelPin'].includes(key)).length && <pre aria-label="Параметры инструмента">{JSON.stringify(Object.fromEntries(Object.entries(value.input).filter(([key]) => !['modelId', 'modelPin'].includes(key))), null, 2)}</pre>}
            {value.output && <pre aria-label="Результат инструмента">{value.output}</pre>}
            {value.status === 'pending' && <Typography.Text type="secondary">Результат ещё не получен.</Typography.Text>}
        </>}</div>}
    </ChatActivityGroup>;
}

export function ChatResearchActivity({steps, conversationId}: {steps?: IChatResearchStepSummary[]; conversationId?: string}): JSX.Element | null {
    const [open, setOpen] = useState(false);
    if (!conversationId || !steps?.length) return null;
    const attempts = [...new Set(steps.map(step => step.attempt))].sort((a, b) => a - b);
    return <ChatActivityGroup className="model-chat__research-activity" icon={<SearchOutlined/>} label={<>Шаги текущей попытки · {steps.length}{attempts.length === 1 ? ` · попытка ${attempts[0]}` : ''}</>} onToggle={event => setOpen(event.currentTarget.open)}>
        {open && <div>{steps.map(step => <ChatResearchStep key={step.id} step={step} conversationId={conversationId}/>)}</div>}
    </ChatActivityGroup>;
}
