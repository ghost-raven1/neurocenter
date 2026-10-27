import {Alert, Button, Empty, Space, Spin, Typography} from 'antd';
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {modelChatUrl} from '../ModelChat/model';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {projectChatAuthor, projectChatLocalAnchor} from './model';
import {DEFAULT_PROJECT_CHAT_ROOM,type ProjectChatMember,type ProjectChatMessage} from './types';
import type {ProjectChatActivity} from './activity.types';
import {ProjectChatSeen} from './ProjectChatActivity';
import {observeVisibleMessages} from './observeVisibleMessages';
import {ChatLog} from '../ChatCommon/ChatLog';
import {AgentToolHistory} from '../AgentTools/AgentToolHistory';
import {ProjectChatMethodWorkflows} from './ProjectChatMethodWorkflows';

interface Props {
    messages: ProjectChatMessage[]; canReply: boolean; action?: string; retryPending?: string[]; historyLoading: boolean; historyError: string; hasMore: boolean;
    onLoadEarlier: () => void; onReply: (message: ProjectChatMessage) => void; onRetry: (id: string) => void; onCancel: (id: string) => void;
    members?: ProjectChatMember[]; activity?: ProjectChatActivity; onVisible?: (ids: string[], currentVisible?: () => string[]) => void;
    privateTasks?: ReactNode; projectId?: string;onRunWorkflow?:(message:ProjectChatMessage)=>void;onRefreshWorkflows?:(messageId:string)=>Promise<unknown>;
}
const stateText: Record<ProjectChatMessage['status'], string> = {queued: 'В очереди', running: 'Готовится ответ', done: '', failed: 'Ответ не получен', cancelled: 'Остановлено'};

/** Every saved human question and agent answer keeps its author and an explicit reply anchor. */
export function ProjectChatMessages({messages, canReply, action, retryPending = [], historyLoading, historyError, hasMore, onLoadEarlier, onReply, onRetry, onCancel, members = [], activity, onVisible, privateTasks, projectId,onRunWorkflow,onRefreshWorkflows}: Props): JSX.Element {
    const inference = useFeatureAvailability('project_chat', 'group_chat'),workflow=useFeatureAvailability('project_agent_chat_workflows');
    const viewport = useRef<HTMLDivElement>(null), nearBottom = useRef(true), previous = useRef<{first: string; last: string; count: number; height: number}>();
    const [newMessages, setNewMessages] = useState(false);
    useLayoutEffect(() => {
        const node = viewport.current; if (!node) return;
        const first = messages[0]?.id ?? '', last = messages[messages.length - 1]?.id ?? '', before = previous.current;
        if (before && messages.length > before.count && first !== before.first && last === before.last) node.scrollTop += node.scrollHeight - before.height;
        else if (!before || nearBottom.current) {node.scrollTop = node.scrollHeight; setNewMessages(false);}
        else if (last !== before.last || node.scrollHeight !== before.height) setNewMessages(true);
        previous.current = {first, last, count: messages.length, height: node.scrollHeight};
    }, [messages, historyLoading, historyError]);
    const messageIds = messages.map(message => message.id).join(',');
    useEffect(() => {if (viewport.current && onVisible) return observeVisibleMessages(viewport.current, onVisible);}, [messageIds, onVisible]);
    return <div className="project-chat__history-wrap"><ChatLog className="project-chat__history" ref={viewport} aria-label="Сообщения команды проекта"
        onScroll={event => {const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; if (nearBottom.current) setNewMessages(false);}}>
        {hasMore && <Button className="project-chat__earlier" loading={historyLoading} onClick={onLoadEarlier}>Показать ранние сообщения</Button>}
        {historyError && <Alert type="warning" showIcon message={historyError}/>}
        {!messages.length && <Empty description="В этом диалоге пока нет сообщений. Напишите участникам или явно выберите агентов для ответа."/>}
        {messages.map(message => {
            const parent = message.replyToId ? messages.find(value => value.id === message.replyToId) : undefined;
            const canQuote = message.kind === 'user' || message.kind === 'agent' && message.status === 'done' && !!message.content;
            return <article id={`project-chat-message-${message.id}`} data-chat-message-id={message.kind === 'user' ? message.id : undefined} tabIndex={-1} key={message.id} className={`project-chat__message project-chat__message_${message.kind}`} aria-label={`${projectChatAuthor(message)}: ${message.kind === 'summary' ? 'итог' : 'сообщение'}`}>
                <header><div><Typography.Text strong>{projectChatAuthor(message)}</Typography.Text><Typography.Text type="secondary">{message.kind === 'agent' ? `Агент · @${message.agent?.slug || 'agent'}` : message.kind === 'summary' ? 'Из ответов на этот вопрос' : 'Участник проекта'}</Typography.Text></div>
                    <div><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString('ru', {hour: '2-digit', minute: '2-digit'})}</time>{message.kind === 'user' && <ProjectChatSeen messageId={message.id} authorEmail={message.author?.email} activity={activity} members={members}/>}</div></header>
                {message.replyToId && <blockquote className="project-chat__quote">{parent ? <><Typography.Text strong>{projectChatAuthor(parent)}</Typography.Text><span>{parent.content.slice(0, 220) || 'Сообщение ещё готовится'}</span></> : <span>Ответ на раннее сообщение · доступно в истории</span>}</blockquote>}
                {message.content && (message.kind === 'user' ? <div className="project-chat__user-content">{message.content}</div> : <div className="project-chat__markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => projectChatLocalAnchor(url) ?? modelChatUrl(url) ?? ''} components={{
                    a: ({href, children}) => {
                        if (!href) return <span>{children}</span>;
                        const anchor = projectChatLocalAnchor(href);
                        if (!anchor) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
                        const loaded = messages.some(value => `#project-chat-message-${value.id}` === anchor);
                        return loaded ? <a href={anchor} onClick={event => {event.preventDefault(); const node = document.getElementById(anchor.slice(1)); if (node && viewport.current?.contains(node)) {node.scrollIntoView({block: 'nearest'}); node.focus({preventScroll: true});}}}>{children}</a>
                            : <Button type="link" size="small" title="Сообщение в ранней истории" aria-label="Показать связанное сообщение из ранней истории" disabled={!hasMore || historyLoading} onClick={onLoadEarlier}>{children} · в ранней истории</Button>;
                    },
                    img: ({alt}) => <span>Изображение: {alt || 'без подписи'}</span>,
                    table: ({children}) => <div className="project-chat__table" tabIndex={0}><table>{children}</table></div>,
                }}>{message.content}</Markdown></div>)}
                {['queued', 'running'].includes(message.status) && <div className="project-chat__pending" role="status"><Spin size="small"/>{stateText[message.status]}{message.kind === 'user' ? ' · остальные участники могут продолжать писать' : ''}</div>}
                {['failed', 'cancelled'].includes(message.status) && <Alert showIcon type={message.status === 'failed' ? 'error' : 'info'} message={message.error || stateText[message.status]}/>}
                {projectId && message.kind === 'user' && message.agentTools && <AgentToolHistory projectId={projectId} turnId={message.id} grant={message.agentTools}/>}
                {projectId&&message.kind==='user'&&!!message.methodWorkflows?.length&&<ProjectChatMethodWorkflows key={JSON.stringify([projectId,message.roomId??DEFAULT_PROJECT_CHAT_ROOM,message.id])} projectId={projectId} roomId={message.roomId??DEFAULT_PROJECT_CHAT_ROOM} messageId={message.id} items={message.methodWorkflows} history={message.methodWorkflowsHistory} onRefresh={()=>onRefreshWorkflows?.(message.id)??Promise.resolve()}/>}
                <Space wrap size={4} className="project-chat__message-actions"><Button type="text" size="small" disabled={!canReply || !canQuote} aria-label={`Ответить · ${projectChatAuthor(message)}`} onClick={() => onReply(message)}>Ответить</Button>
                    {message.kind==='user'&&onRunWorkflow&&<Button type="text" size="small" title={workflow.enabled?'Открыть методику, выбор агента и историю задачи':`${workflow.reason}. История и проверка отправки доступны.`} aria-label={`Выполнить задачу · ${projectChatAuthor(message)}`} onClick={()=>onRunWorkflow(message)}>Выполнить задачу</Button>}
                    {(message.canRetry || retryPending.includes(message.id)) && <Button size="small" disabled={!!action || !inference.enabled && !retryPending.includes(message.id)} loading={action === message.id} onClick={() => onRetry(message.id)}>{retryPending.includes(message.id) ? 'Проверить повтор отправки' : 'Повторить неуспешные ответы'}</Button>}
                    {message.canCancel && <Button size="small" disabled={!!action} loading={action === message.id} onClick={() => onCancel(message.id)}>Остановить ответы</Button>}
                </Space>
            </article>;
        })}
        {privateTasks}
    </ChatLog>{newMessages && <Button className="project-chat__latest" onClick={() => {const node = viewport.current; if (node) node.scrollTop = node.scrollHeight; nearBottom.current = true; setNewMessages(false);}}>К последним сообщениям</Button>}</div>;
}
