import {DeleteOutlined, EditOutlined, MenuOutlined, PlusOutlined} from '@ant-design/icons';
import {Alert, Button, Input, Modal, Space, Spin, Typography} from 'antd';
import {useEffect, useRef, useState} from 'react';
import {AttachmentPreview} from './AttachmentPreview';
import {ChatAttachments} from './ChatAttachments';
import {ChatComposer} from './ChatComposer';
import {ChatContextMeter} from './ChatContextMeter';
import {ChatMessages} from './ChatMessages';
import {ConversationList} from './ConversationList';
import type {IModelChatProps} from './types';
import {useChatContext} from './useChatContext';
import {useModelChat} from './useModelChat';
import './ModelChat.less';

/** Saved personal conversations retain model and project scope across openings of the catalogue. */
export function ModelChatModal({model, projectId, projectName, unavailableReason, onClose}: IModelChatProps): JSX.Element {
    const chat = useModelChat(model, projectId, unavailableReason);
    const [draft, setDraft] = useState(''), [fileError, setFileError] = useState(''), [preview, setPreview] = useState<string>();
    const [listOpen, setListOpen] = useState(false), [renaming, setRenaming] = useState(false), [title, setTitle] = useState('');
    const confirmation = useRef<{destroy: () => void}>();
    const context = useChatContext(chat.detail, draft, chat.attachments.map(file => file.id));
    const unresolved = chat.turns.some(turn => turn.status !== 'done'), disabled = !!chat.activity || unresolved || !!chat.blocked;
    const hasDraft = !!draft.trim() || !!chat.uploads.length;
    useEffect(() => () => confirmation.current?.destroy(), []);
    const confirm = (action: () => void, message: string): void => {
        if (!hasDraft && chat.activity !== 'sending' && chat.activity !== 'uploading') {action(); return;}
        if (confirmation.current) return;
        const owns = chat.captureOwner();
        confirmation.current = Modal.confirm({title: message, content: (chat.activity === 'sending' ? 'Запрос из этого окна будет остановлен. ' : chat.activity === 'uploading' ? 'Загрузка будет прервана. ' : '') + 'Неотправленный текст будет очищен. Сохранённые сообщения и документы останутся в диалоге.',
            okText: 'Продолжить', cancelText: 'Отмена', onOk: () => {confirmation.current = undefined; if (owns()) action();}, onCancel: () => {confirmation.current = undefined;}});
    };
    const close = (): void => confirm(() => {if (chat.activity === 'uploading') chat.cancelUploads(); else chat.stopOwn(); onClose();}, 'Закрыть чат?');
    const newChat = (): void => confirm(() => {const owns = chat.captureOwner(); void chat.newChat().then(ok => {if (ok && owns()) {setDraft(''); setFileError(''); setPreview(undefined); setListOpen(false);}});}, 'Начать новый диалог?');
    const select = (id: string): void => {if (id === chat.detail?.conversation.id) {setListOpen(false); return;} confirm(() => {const owns = chat.captureOwner(); void chat.select(id).then(ok => {if (ok && owns()) {setDraft(''); setFileError(''); setPreview(undefined); setListOpen(false);}});}, 'Открыть другой диалог?');};
    const send = (): void => {if (chat.send(draft)) {setDraft(''); setFileError('');}};
    const edit = async (): Promise<void> => {const owns = chat.captureOwner(), value = await chat.editFailed(); if (owns() && value !== undefined) setDraft(value);};
    const remove = (): void => {
        if (confirmation.current) return; const owns = chat.captureOwner();
        confirmation.current = Modal.confirm({title: 'Удалить диалог и его документы?', content: 'Вся переписка и вложения этого диалога будут удалены.', okText: 'Удалить', okButtonProps: {danger: true}, cancelText: 'Отмена',
            onOk: async () => {confirmation.current = undefined; if (owns()) {const ok = await chat.remove(); if (ok && owns()) {setDraft(''); setPreview(undefined);}}}, onCancel: () => {confirmation.current = undefined;}});
    };
    const lastAnswer = [...chat.turns].reverse().find(turn => turn.answer)?.answer, lastTurn = chat.turns[chat.turns.length - 1];
    const contextBlocked = context.rejected || !!context.context?.exceeded && !context.context.canCompact;
    return <Modal open centered width={1280} className="model-chat" title={<div className="model-chat__title">Чат · {model.name}<Typography.Text type="secondary">{projectName ? `Проект «${projectName}»` : 'Общий каталог'} · личные диалоги</Typography.Text></div>}
        onCancel={close} footer={null} destroyOnClose>
        <div className={'model-chat__layout' + (listOpen ? ' model-chat__layout_list-open' : '')}>
            <aside id="model-chat-conversations" className="model-chat__sidebar"><ConversationList items={chat.items} selected={chat.detail?.conversation.id} disabled={!!chat.activity && !chat.busy} loading={chat.activity === 'loading'}
                onSelect={select} onNew={newChat} onRefresh={() => {void chat.refresh();}}/></aside>
            <main className="model-chat__main">
                <div className="model-chat__scope"><div className="model-chat__dialog-title"><Typography.Text strong>{chat.detail?.conversation.title || 'Новый диалог'}</Typography.Text><Typography.Text type="secondary">{model.model}</Typography.Text></div>
                    <Space size={4}><Button className="model-chat__mobile-menu" icon={<MenuOutlined/>} aria-expanded={listOpen} aria-controls="model-chat-conversations" onClick={() => setListOpen(!listOpen)}>Диалоги</Button>
                        <Button type="text" icon={<PlusOutlined/>} aria-label="Создать новый диалог" disabled={!!chat.activity && !chat.busy} onClick={newChat}/>
                        <Button type="text" icon={<EditOutlined/>} aria-label="Переименовать диалог" disabled={!chat.detail || !!chat.activity || chat.busy} onClick={() => {setTitle(chat.detail?.conversation.title || ''); setRenaming(true);}}/>
                        <Button type="text" danger icon={<DeleteOutlined/>} aria-label="Удалить диалог" disabled={!chat.detail || !!chat.activity || chat.busy} onClick={remove}/></Space>
                </div>
                {chat.blocked && <Alert type="warning" showIcon message={chat.blocked} className="model-chat__notice"/>}
                {(chat.error || fileError) && <Alert type="error" showIcon message={fileError || chat.error} className="model-chat__notice"/>}
                {chat.activity === 'loading' && !chat.detail ? <div className="model-chat__loading" role="status"><Spin tip="Загружаем личные диалоги…"/></div>
                    : <ChatMessages key={chat.detail?.conversation.id || 'new'} turns={chat.turns} attachments={chat.detail?.attachments ?? []} modelName={model.name} blocked={!!chat.blocked} busy={!!chat.activity}
                        onRetry={chat.retry} onEdit={() => {void edit();}} onPreview={setPreview} hasEarlier={chat.detail?.history?.hasMore ?? false} historyLoading={chat.historyLoading} historyError={chat.historyError} onLoadEarlier={() => {void chat.loadEarlier();}}/>}
                <ChatContextMeter context={context.context} loading={context.loading} error={context.error} rejected={context.rejected} usage={lastAnswer?.usage} compaction={chat.detail?.compaction} phase={lastTurn?.status === 'pending' || lastTurn?.status === 'failed' ? lastTurn.processingStage : undefined} failed={lastTurn?.status === 'failed'}/>
                <ChatAttachments files={chat.attachments} uploads={chat.uploads} disabled={!!chat.activity || unresolved} onPreview={setPreview} onRemove={id => {void chat.removeAttachment(id);}}
                    onRetryUpload={chat.retryUpload} onRemoveUpload={chat.removeUpload}/>
                <ChatComposer draft={draft} disabled={disabled} canSend={!disabled && !chat.uploads.length && !contextBlocked && (!!draft.trim() || !!chat.attachments.length)}
                    sending={chat.busy} uploading={chat.activity === 'uploading'} onDraft={setDraft} onSend={send} onStop={() => {void chat.stop();}} onCancelUpload={chat.cancelUploads}
                    onFiles={files => {setFileError(''); chat.addFiles(files);}} onReject={setFileError}/>
            </main>
            {listOpen && <Button className="model-chat__mobile-list-close" onClick={() => setListOpen(false)}>Вернуться к чату</Button>}
        </div>
        {preview && chat.detail && <AttachmentPreview key={`${chat.detail.conversation.id}:${preview}`} conversationId={chat.detail.conversation.id} attachmentId={preview} onClose={() => setPreview(undefined)}/>}
        <Modal open={renaming} title="Название диалога" onCancel={() => setRenaming(false)} okText="Сохранить" cancelText="Отмена" confirmLoading={chat.activity === 'saving'}
            okButtonProps={{disabled: !title.trim() || title.trim().length > 128 || !!chat.activity}} onOk={() => {const owns = chat.captureOwner(); void chat.rename(title.trim()).then(ok => {if (ok && owns()) setRenaming(false);});}}>
            {chat.error && <Alert type="error" message={chat.error}/>}<Input autoFocus aria-label="Название диалога" value={title} maxLength={128} onChange={event => setTitle(event.target.value)}/>
        </Modal>
    </Modal>;
}
