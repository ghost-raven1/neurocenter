import {CopyOutlined, MessageOutlined} from '@ant-design/icons';
import {Alert, Button, Empty, Space, Spin, Typography} from 'antd';
import {useLayoutEffect, useRef, useState} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {modelChatUrl} from './model';
import type {IModelChatAttachment, IModelChatTurn} from './types';

interface Props {turns: IModelChatTurn[]; attachments: IModelChatAttachment[]; modelName: string; blocked: boolean; busy: boolean; onRetry: () => void; onEdit: () => void; onPreview: (id: string) => void; hasEarlier?: boolean; historyLoading?: boolean; historyError?: string; onLoadEarlier?: () => void;}

/** Markdown stays inert; files are explicitly opened and never auto-fetch third-party resources. */
export function ChatMessages({turns, attachments, modelName, blocked, busy, onRetry, onEdit, onPreview, hasEarlier, historyLoading, historyError, onLoadEarlier}: Props): JSX.Element {
    const viewport = useRef<HTMLDivElement>(null), nearBottom = useRef(true), previous = useRef<{first: string; last: string; count: number; height: number; stamp: string}>();
    const [copyError, setCopyError] = useState(''), [copied, setCopied] = useState(''), [showLatest, setShowLatest] = useState(false);
    useLayoutEffect(() => {
        const node = viewport.current; if (!node) return;
        const tail = turns[turns.length - 1], first = turns[0]?.id ?? '', last = tail?.requestId ?? '', before = previous.current;
        const stamp = `${tail?.status}:${tail?.answer?.content.length ?? 0}`;
        if (before && turns.length > before.count && first !== before.first && last === before.last) node.scrollTop += node.scrollHeight - before.height;
        else if (!before || nearBottom.current) {node.scrollTop = node.scrollHeight; setShowLatest(false);}
        else if (last !== before.last || stamp !== before.stamp) setShowLatest(true);
        previous.current = {first, last, count: turns.length, height: node.scrollHeight, stamp};
    }, [turns, historyLoading, historyError]);
    const copy = async (turn: IModelChatTurn): Promise<void> => {
        if (!turn.answer) return;
        try {await navigator.clipboard.writeText(turn.answer.content); setCopied(turn.id); setCopyError('');}
        catch {setCopyError('Не удалось скопировать ответ. Выделите текст и скопируйте его вручную.');}
    };
    return <div className="model-chat__history-wrap"><div ref={viewport} className="model-chat__history" role="log" aria-label="История чата" aria-live="polite" aria-relevant="additions text"
        onScroll={event => {const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; if (nearBottom.current) setShowLatest(false);}}>
        {hasEarlier && <div className="model-chat__earlier"><Button loading={historyLoading} disabled={historyLoading} onClick={onLoadEarlier}>Показать ранние сообщения</Button></div>}
        {historyError && <Alert type="warning" showIcon message={historyError}/>}
        {!turns.length && <Empty image={<MessageOutlined/>} description="Задайте вопрос или прикрепите документ"/>}
        {turns.map((turn, index) => <section key={turn.id} className="model-chat__turn">
            <article className="model-chat__message model-chat__message_user" aria-label="Ваше сообщение"><Typography.Text strong>Вы</Typography.Text>
                {turn.prompt && <div className="model-chat__prompt">{turn.prompt}</div>}
                {!!turn.attachmentIds.length && <div className="model-chat__message-files">{turn.attachmentIds.map(id => {const file = attachments.find(value => value.id === id); return <Button key={id} size="small" type="link" onClick={() => onPreview(id)}>{file?.name ?? 'Документ'}</Button>;})}</div>}
            </article>
            <article className="model-chat__message model-chat__message_assistant" aria-label="Ответ модели"><div className="model-chat__message-heading"><Typography.Text strong>{modelName}</Typography.Text>
                {turn.answer && <Button size="small" type="text" icon={<CopyOutlined/>} onClick={() => {void copy(turn);}} aria-label="Скопировать ответ">{copied === turn.id ? 'Скопировано' : 'Копировать'}</Button>}</div>
                {turn.answer && <div className="model-chat__markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => modelChatUrl(url) ?? ''} components={{
                    a: ({href, children}) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
                    img: ({alt}) => <span>Изображение: {alt || 'без подписи'}</span>,
                    table: ({children}) => <div className="model-chat__table" tabIndex={0}><table>{children}</table></div>,
                }}>{turn.answer.content}</Markdown></div>}
                {turn.status === 'pending' && <div role="status" className="model-chat__pending"><Spin size="small"/> {turn.processingStage === 'compacting' ? 'Сжимаем раннюю переписку…' : 'Модель готовит ответ…'}</div>}
                {turn.answer?.finishReason === 'length' && <Alert type="warning" showIcon message="Ответ достиг лимита токенов. Можно попросить модель продолжить."/>}
                {['failed', 'cancelled'].includes(turn.status) && <><Alert type={turn.status === 'cancelled' ? 'info' : 'error'} showIcon message={turn.status === 'failed' && turn.processingStage === 'compacting' ? 'Не удалось сжать раннюю переписку. История сохранена; повторите запрос.' : turn.error || (turn.status === 'cancelled' ? 'Запрос остановлен.' : 'Ответ не получен.')}/>
                    {index === turns.length - 1 && <Space wrap className="model-chat__retry"><Button disabled={busy || blocked} onClick={onRetry}>Повторить запрос</Button><Button disabled={busy} onClick={onEdit}>Изменить сообщение</Button></Space>}</>}
            </article>
        </section>)}
        {copyError && <Alert type="warning" message={copyError}/>}
    </div>{showLatest && <Button className="model-chat__latest" size="small" onClick={() => {const node = viewport.current; if (node) node.scrollTop = node.scrollHeight; nearBottom.current = true; setShowLatest(false);}}>К последним сообщениям</Button>}</div>;
}
