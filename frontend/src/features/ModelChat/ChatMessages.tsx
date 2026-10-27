import {MessageOutlined} from '@ant-design/icons';
import {Alert, Button, Empty, Space, Spin, Typography} from 'antd';
import {useLayoutEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {ChatResearchHistory} from './ChatResearchHistory';
import {ChatAnswer} from './ChatAnswer';
import type {IModelChatAttachment, IModelChatTurn} from './types';
import type {TFeatureFlagKey} from '../FeatureFlags/types';
import {FeatureButton} from '../FeatureFlags/FeatureAvailability';
import {ChatLog} from '../ChatCommon/ChatLog';
import {AgentToolHistory} from '../AgentTools/AgentToolHistory';
import {ChatDocumentIcon} from '../ChatCommon/ChatDocumentIcon';

interface Props {turns: IModelChatTurn[]; attachments: IModelChatAttachment[]; modelName: string; blocked: boolean; busy: boolean; onRetry: () => void; onEdit: () => void; onPreview: (id: string) => void; hasEarlier?: boolean; historyLoading?: boolean; historyError?: string; onLoadEarlier?: () => void; onComplete?: () => void; group?: boolean; conversationId?: string; privateTasks?: ReactNode; projectId?: string;}

const retryFeatures = (group: boolean | undefined, turn: IModelChatTurn): TFeatureFlagKey[] => [group ? 'group_chat' : 'model_chat',
    ...(turn.research ? ['research_tools' as const, ...(turn.research.project ? ['project_search' as const] : []), ...(turn.research.external ? ['tool_catalog' as const] : [])] : [])];

/** Markdown stays inert; files are explicitly opened and never auto-fetch third-party resources. */
export function ChatMessages({turns, attachments, modelName, blocked, busy, onRetry, onEdit, onPreview, hasEarlier, historyLoading, historyError, onLoadEarlier, onComplete, group, conversationId, privateTasks, projectId}: Props): JSX.Element {
    const viewport = useRef<HTMLDivElement>(null), nearBottom = useRef(true), previous = useRef<{first: string; last: string; count: number; height: number; stamp: string}>();
    const [showLatest, setShowLatest] = useState(false);
    useLayoutEffect(() => {
        const node = viewport.current; if (!node) return;
        const tail = turns[turns.length - 1], first = turns[0]?.id ?? '', last = tail?.requestId ?? '', before = previous.current;
        const stamp = `${tail?.status}:${tail?.answer?.content.length ?? 0}:${tail?.responses?.map(response => `${response.id}:${response.status}:${response.answer?.content.length ?? 0}`).join(',') ?? ''}`;
        if (before && turns.length > before.count && first !== before.first && last === before.last) node.scrollTop += node.scrollHeight - before.height;
        else if (!before || nearBottom.current) {node.scrollTop = node.scrollHeight; setShowLatest(false);}
        else if (last !== before.last || stamp !== before.stamp) setShowLatest(true);
        previous.current = {first, last, count: turns.length, height: node.scrollHeight, stamp};
    }, [turns, historyLoading, historyError]);
    return <div className="model-chat__history-wrap"><ChatLog ref={viewport} className="model-chat__history" aria-label="История чата"
        onScroll={event => {const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; if (nearBottom.current) setShowLatest(false);}}>
        {hasEarlier && <div className="model-chat__earlier"><Button loading={historyLoading} disabled={historyLoading} onClick={onLoadEarlier}>Показать ранние сообщения</Button></div>}
        {historyError && <Alert type="warning" showIcon message={historyError}/>}
        {!turns.length && <Empty image={<MessageOutlined/>} description="Задайте вопрос или прикрепите документ"/>}
        {turns.map((turn, index) => <section key={turn.id} className="model-chat__turn">
            <article className="model-chat__message model-chat__message_user" aria-label="Ваше сообщение"><Typography.Text strong>Вы</Typography.Text>
                {turn.research && <Typography.Text type="secondary" className="model-chat__recipients">Исследование · {[turn.research.project ? 'база знаний проекта' : '', turn.research.external ? 'внешние источники' : ''].filter(Boolean).join(' · ')}</Typography.Text>}
                {turn.prompt && <div className="model-chat__prompt">{turn.prompt}</div>}
                {!!turn.attachmentIds.length && <div className="model-chat__message-files">{turn.attachmentIds.map(id => {const file = attachments.find(value => value.id === id), name = file?.name ?? 'Документ'; return <Button key={id} className="model-chat__document-tile" aria-label={name} onClick={() => onPreview(id)}><ChatDocumentIcon name={name}/><span>{name}</span></Button>;})}</div>}
            </article>
            {turn.responses?.length ? turn.responses.map(response => <ChatAnswer key={response.id} name={response.name} modelName={response.modelName} group answer={response.answer} status={response.status} executionState={response.executionState} error={response.error} phase={response.processingStage} conversationId={conversationId} researchSteps={turn.researchSteps?.filter(step => step.responseId === response.id)}/>)
                : turn.discussion ? null : group && turn.status === 'pending' ? <div className="model-chat__pending" role="status"><Spin size="small"/>{turn.processingStage === 'researching' ? 'Исследуем источники…' : turn.processingStage === 'compacting' ? 'Сжимаем раннюю переписку…' : 'Запрос принят · ожидаем начало ответов…'}</div>
                    : <ChatAnswer name={modelName} answer={turn.answer} status={turn.status} executionState={turn.executionState} error={turn.error} phase={turn.processingStage} conversationId={conversationId} researchSteps={turn.researchSteps?.filter(step => !step.responseId)}/>}
            {turn.discussion && turn.status === 'pending' && <div className="model-chat__pending" role="status"><Spin size="small"/>Агенты обсуждают задачу…</div>}
            {turn.discussion && ['failed', 'cancelled'].includes(turn.status) && <Alert type={turn.status === 'cancelled' ? 'info' : 'warning'} showIcon message={turn.error || 'Обсуждение не завершено.'} description="Продолжите новым сообщением. Готовые ответы останутся в истории."/>}
            {turn.research && conversationId && !turn.id.startsWith('client:') && <ChatResearchHistory conversationId={conversationId} turnId={turn.id} requestId={turn.requestId} responses={turn.responses}/>}
            {turn.agentTools && projectId && !turn.id.startsWith('client:') && <AgentToolHistory projectId={projectId} turnId={turn.id} grant={turn.agentTools}/>}
            {!turn.discussion && ['failed', 'cancelled'].includes(turn.status) && index === turns.length - 1 && <Space wrap className="model-chat__retry"><FeatureButton features={retryFeatures(group, turn)} disabled={busy || blocked} onClick={onRetry}>{turn.responses?.length ? 'Повторить неуспешные ответы' : 'Повторить запрос'}</FeatureButton>
                {turn.responses?.some(response => response.status === 'done') ? <Button disabled={busy} onClick={onComplete}>Продолжить с готовыми ответами</Button> : <Button disabled={busy} onClick={onEdit}>Изменить сообщение</Button>}</Space>}
        </section>)}
        {privateTasks}
    </ChatLog>{showLatest && <Button className="model-chat__latest" size="small" onClick={() => {const node = viewport.current; if (node) node.scrollTop = node.scrollHeight; nearBottom.current = true; setShowLatest(false);}}>К последним сообщениям</Button>}</div>;
}
