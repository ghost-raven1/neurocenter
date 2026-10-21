import {Alert, Button, Spin, Typography} from 'antd';
import {useState} from 'react';
import {ChatResearchStep} from './ChatResearchActivity';
import {useChatResearchHistory} from './useChatResearchHistory';
import type {IModelChatResponse} from './types';

interface Props {conversationId: string; turnId: string; requestId: string; responses?: IModelChatResponse[];}

/** Every earlier attempt remains discoverable without loading its large outputs into the chat. */
export function ChatResearchHistory({conversationId, turnId, requestId, responses}: Props): JSX.Element {
    const [open, setOpen] = useState(false), history = useChatResearchHistory(open, conversationId, turnId, requestId);
    return <details className="model-chat__research-activity" onToggle={event => setOpen(event.currentTarget.open)}><summary>Все попытки исследования</summary>
        {open && <div>{history.page?.items.map(step => <div key={step.id}>
            {step.responseId && <Typography.Text strong>{responses?.find(response => response.id === step.responseId)?.name || 'Участник группы'} · попытка {step.attempt}</Typography.Text>}
            <ChatResearchStep step={step} conversationId={conversationId}/>
        </div>)}
            {history.loading && <Spin size="small"/>}
            {history.error && <><Alert type="warning" message={history.error}/><Button size="small" onClick={history.retry}>Повторить загрузку попыток</Button></>}
            {!history.loading && !history.error && history.page?.history.hasMore && <Button size="small" onClick={history.more}>Показать ещё шаги</Button>}
            {!history.loading && !history.error && !history.page?.items.length && <Typography.Text type="secondary">Сохранённых шагов пока нет.</Typography.Text>}
        </div>}
    </details>;
}
