import { MessageOutlined, ReloadOutlined, SendOutlined, StopOutlined } from '@ant-design/icons';
import { Alert, Button, Empty, Input, Modal, Space, Spin, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { modelChatContextError, modelChatUrl } from './model';
import type { IModelChatProps } from './types';
import { useModelChat } from './useModelChat';
import './ModelChat.less';

/** Text conversations use the same checked model connection as project inference. */
export function ModelChatModal({ model, projectId, projectName, unavailableReason, onClose }: IModelChatProps): JSX.Element {
    const chat = useModelChat(model, projectId, unavailableReason), [draft, setDraft] = useState('');
    const end = useRef<HTMLDivElement>(null), composing = useRef(false), confirmation = useRef<{ destroy: () => void }>();
    const tail = chat.turns[chat.turns.length - 1], unresolved = !!tail && tail.status !== 'done';
    const contextError = !unresolved ? modelChatContextError(chat.turns) : '';
    useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [chat.turns]);
    useEffect(() => () => confirmation.current?.destroy(), []);
    const confirm = (action: () => void, close = false): void => {
        if (!chat.turns.length && !draft.trim()) { action(); return; }
        if (confirmation.current) return;
        const owns = chat.captureOwner();
        confirmation.current = Modal.confirm({ title: close ? 'Закрыть чат?' : 'Начать новый диалог?',
            content: chat.busy ? 'Текущий запрос будет остановлен. История этого чата не сохраняется.'
                : draft.trim() ? 'Несохранённое сообщение и история этого чата будут очищены.' : 'История этого чата не сохраняется и будет очищена.',
            okText: close ? 'Закрыть чат' : 'Начать новый', cancelText: 'Отмена',
            onOk: () => { confirmation.current = undefined; if (owns()) action(); }, onCancel: () => { confirmation.current = undefined; } });
    };
    const close = (): void => confirm(() => { chat.stop(); onClose(); }, true);
    const send = (): void => { if (chat.send(draft)) setDraft(''); };
    return <Modal open centered width={900} className="model-chat" title={<span>Чат · {model.name}</span>} onCancel={close} footer={null} destroyOnClose>
        <div className="model-chat__scope"><Typography.Text type="secondary">{projectName ? `Проект «${projectName}»` : 'Общий каталог'} · {model.model}</Typography.Text>
            <Button size="small" icon={<ReloadOutlined />} disabled={!chat.turns.length && !draft.trim() && !chat.blocked} onClick={() => confirm(() => { chat.reset(); setDraft(''); })}>Новый диалог</Button></div>
        <Typography.Paragraph type="secondary" className="model-chat__hint">{model.capability === 'vision' ? 'Текстовый чат с моделью изображений. ' : ''}Используются сохранённые параметры подключения. История хранится только до закрытия чата.</Typography.Paragraph>
        {chat.blocked && <Alert type="warning" showIcon message={chat.blocked} className="model-chat__notice" />}
        {chat.error && <Alert type="error" showIcon message={chat.error} className="model-chat__notice" />}
        <div className="model-chat__history" role="log" aria-label="История чата" aria-live="polite" aria-relevant="additions text">
            {!chat.turns.length && <Empty image={<MessageOutlined />} description="Задайте вопрос модели" />}
            {chat.turns.map(turn => <section key={turn.id} className="model-chat__turn">
                <article className="model-chat__message model-chat__message_user" aria-label="Ваше сообщение"><Typography.Text strong>Вы</Typography.Text><div className="model-chat__prompt">{turn.prompt}</div></article>
                <article className="model-chat__message model-chat__message_assistant" aria-label="Ответ модели"><Typography.Text strong>{model.name}</Typography.Text>
                    {turn.answer && <div className="model-chat__markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => modelChatUrl(url) ?? ''} components={{
                        a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
                        img: ({ alt }) => <span>Изображение: {alt || 'без подписи'}</span>,
                        table: ({ children }) => <div className="model-chat__table" tabIndex={0}><table>{children}</table></div>,
                    }}>{turn.answer.content}</Markdown></div>}
                    {turn.status === 'pending' && <div role="status" className="model-chat__pending"><Spin size="small" /> Модель готовит ответ…</div>}
                    {turn.answer?.finishReason === 'length' && <Alert type="warning" showIcon message="Ответ достиг лимита токенов. Можно попросить модель продолжить." />}
                    {turn.error && <><Alert type={turn.status === 'cancelled' ? 'info' : 'error'} showIcon message={turn.error} />
                        <Space wrap className="model-chat__retry"><Button disabled={!!chat.blocked} onClick={chat.retry}>Повторить запрос</Button><Button onClick={() => { const prompt = chat.editFailed(); if (prompt !== undefined) setDraft(prompt); }}>Изменить сообщение</Button></Space></>}
                </article>
            </section>)}
            <div ref={end} />
        </div>
        {contextError && <Alert type="info" showIcon className="model-chat__notice" message={contextError} />}
        <div className="model-chat__composer">
            <label htmlFor="model-chat-message" className="model-chat__label">Сообщение модели</label>
            <Input.TextArea id="model-chat-message" value={draft} autoSize={{ minRows: 2, maxRows: 6 }} placeholder="Введите сообщение…" disabled={chat.busy || unresolved || !!chat.blocked || !!contextError}
                onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
                onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); send(); } }} />
            <div className="model-chat__composer-actions"><Typography.Text type="secondary">Enter — отправить · Shift+Enter — новая строка</Typography.Text>
                {chat.busy ? <Button icon={<StopOutlined />} onClick={chat.stop}>Остановить</Button> : <Button type="primary" icon={<SendOutlined />} disabled={!draft.trim() || unresolved || !!chat.blocked || !!contextError} onClick={send}>Отправить</Button>}</div>
        </div>
    </Modal>;
}
