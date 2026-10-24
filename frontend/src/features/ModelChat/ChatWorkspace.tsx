import {DeleteOutlined, EditOutlined, MenuOutlined, MoreOutlined, PlusOutlined, TeamOutlined} from '@ant-design/icons';
import {Alert, Button, Dropdown, Input, Modal, Space, Spin, Tooltip, Typography} from 'antd';
import {useEffect, useRef, useState} from 'react';
import {AttachmentPreview} from './AttachmentPreview';
import {ChatAttachments} from './ChatAttachments';
import {ChatResearchControls} from './ChatResearchControls';
import {useChatResearch} from './useChatResearch';
import {ChatComposer} from './ChatComposer';
import {ChatContextMeter} from './ChatContextMeter';
import {ChatParticipantsEditor} from './ChatParticipantsEditor';
import {ChatProjectContext} from './ChatProjectContext';
import {ChatMessages} from './ChatMessages';
import {ConversationList} from './ConversationList';
import {modelChatContextBlocked} from './model';
import type {IChatWorkspaceNavigation,IModelChatProps} from './types';
import {useChatContext} from './useChatContext';
import {useModelChat} from './useModelChat';
import {FeatureAvailabilityNotice, FeatureButton, useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import './ModelChat.less';

/** Saved personal conversations retain model and project scope across openings of the catalogue. */
export function ChatWorkspace({model, projectId, projectName, unavailableReason, onClose, navigation}: IModelChatProps & {navigation?: IChatWorkspaceNavigation}): JSX.Element {
    const chat = useModelChat(model, projectId, unavailableReason, navigation ? {initialDetail: navigation.initialDetail, autoSelect: false} : undefined);
    const availability = useFeatureAvailability(chat.detail?.conversation.mode === 'group' ? 'group_chat' : 'model_chat');
    const newConversationAvailable = useFeatureAvailability('model_chat');
    const groupsAvailable = useFeatureAvailability('group_chat');
    const searchAvailable = useFeatureAvailability('project_search');
    const researchAvailable = useFeatureAvailability('research_tools');
    const research = useChatResearch(model.id, projectId, chat.detail?.conversation.id, chat.captureOwner);
    const [draft, setDraft] = useState(''), [fileError, setFileError] = useState(''), [preview, setPreview] = useState<string>();
    const [listOpen, setListOpen] = useState(false), [renaming, setRenaming] = useState(false), [title, setTitle] = useState('');
    const [actionsOpen, setActionsOpen] = useState(false);
    const actionTrigger = useRef<HTMLButtonElement>(null);
    const [configuration, setConfiguration] = useState({id: navigation?.initialDetail?.conversation.id, open: !navigation?.initialDetail?.turns.length});
    const [participantsEditor, setParticipantsEditor] = useState<'create' | 'edit' | undefined>(navigation?.initialGroup ? 'create' : undefined);
    const participantScope = JSON.stringify([projectId, model.id, chat.detail?.conversation.id]), participantRoot = JSON.stringify([projectId, model.id]);
    const liveParticipantScope = useRef({scope: participantScope, root: participantRoot}); liveParticipantScope.current = {scope: participantScope, root: participantRoot};
    const participantReturn = useRef<{scope: string; root: string; trigger?: HTMLElement; created?: boolean; owns?: () => boolean}>();
    const participantFocus = useRef<{scope: string; owns: () => boolean; trigger?: HTMLElement}>();
    const participantSummary = useRef<HTMLElement>(null), metadata = useRef<HTMLDivElement>(null);
    if (participantsEditor && !participantReturn.current) participantReturn.current = {scope: participantScope, root: participantRoot};
    const confirmation = useRef<{destroy: () => void}>();
    const context = useChatContext(chat.detail, draft, chat.attachments.map(file => file.id), availability.enabled);
    const unresolved = chat.turns.some(turn => turn.status !== 'done'), disabled = !!chat.activity || unresolved || !!chat.blocked || !!navigation?.opening || !availability.enabled;
    const hasDraft = !!draft.trim() || !!chat.uploads.length || research.enabled;
    useEffect(() => () => confirmation.current?.destroy(), []);
    useEffect(() => {navigation?.onChanged(chat.detail?.conversation ?? null);}, [chat.detail?.conversation, navigation?.onChanged]);
    useEffect(() => {
        const pending = participantFocus.current; if (participantsEditor || !pending) return;
        participantFocus.current = undefined;
        if (pending.scope !== participantScope || !pending.owns()) return;
        const target = pending.trigger?.isConnected && !pending.trigger.matches(':disabled') ? pending.trigger
            : participantSummary.current ?? metadata.current?.querySelector<HTMLButtonElement>('button:not([disabled])');
        target?.focus();
    }, [participantsEditor, participantScope]);
    const confirm = (action: () => void, message: string): void => {
        if (!hasDraft && chat.activity !== 'sending' && chat.activity !== 'uploading') {action(); return;}
        if (confirmation.current) return;
        const owns = chat.captureOwner();
        confirmation.current = Modal.confirm({title: message, content: (chat.activity === 'sending' ? 'Запрос из этого окна будет остановлен. ' : chat.activity === 'uploading' ? 'Загрузка будет прервана. ' : '') + 'Неотправленный текст будет очищен. Сохранённые сообщения и документы останутся в диалоге.',
            okText: 'Продолжить', cancelText: 'Отмена', onOk: () => {confirmation.current = undefined; if (owns()) action();}, onCancel: () => {confirmation.current = undefined;}});
    };
    const close = (): void => confirm(() => {if (chat.activity === 'uploading') chat.cancelUploads(); else chat.stopOwn(); onClose();}, 'Закрыть чат?');
    const newChat = (): void => confirm(() => {const owns = chat.captureOwner(); void chat.newChat().then(ok => {if (ok && owns()) {setDraft(''); research.reset(); setFileError(''); setPreview(undefined); setListOpen(false);}});}, 'Начать новый диалог?');
    const select = (id: string): void => {if (id === chat.detail?.conversation.id) {setListOpen(false); return;} confirm(() => {
        const item = navigation?.items.find(value => value.id === id);
        if (item && item.modelId !== model.id) {if(chat.activity==='uploading')chat.cancelUploads();else chat.stopOwn();navigation?.onSelect(item);return;}
        const owns = chat.captureOwner(); void chat.select(id).then(ok => {if (ok && owns()) {setDraft(''); research.reset(); setFileError(''); setPreview(undefined); setListOpen(false);}});
    }, 'Открыть другой диалог?');};
    const researchBlocked = research.enabled && (!researchAvailable.enabled || !research.request);
    const send = (): void => {if (availability.enabled && !researchBlocked && chat.send(draft, research.request)) {setDraft(''); research.reset(); setFileError('');}};
    const edit = async (): Promise<void> => {const owns = chat.captureOwner(), consent = chat.turns[chat.turns.length - 1]?.research, value = await chat.editFailed(); if (owns() && value !== undefined) {setDraft(value); research.restore(consent);}};
    const remove = (): void => {
        if (confirmation.current) return; const owns = chat.captureOwner();
        confirmation.current = Modal.confirm({title: 'Удалить диалог и его документы?', content: 'Вся переписка и вложения этого диалога будут удалены.', okText: 'Удалить', okButtonProps: {danger: true}, cancelText: 'Отмена',
            onOk: async () => {confirmation.current = undefined; if (owns()) {const ok = await chat.remove(); if (ok && owns()) {setDraft(''); research.reset(); setPreview(undefined);}}}, onCancel: () => {confirmation.current = undefined;}});
    };
    const lastTurn = chat.turns[chat.turns.length - 1], group = chat.detail?.conversation.mode === 'group';
    const configurationOpen = configuration.id === chat.detail?.conversation.id ? configuration.open : !chat.turns.length;
    const lastAnswer = [...chat.turns].reverse().flatMap(turn => turn.responses?.map(response => response.answer).reverse() ?? [turn.answer]).find(answer => !!answer);
    const closeActionsOnEscape = (event: React.KeyboardEvent<HTMLElement>): void => {
        if (!actionsOpen || event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); setActionsOpen(false); actionTrigger.current?.focus();
    };
    const contextBlocked = context.rejected || modelChatContextBlocked(context.context);
    const saveParticipants = async (ids: string[]): Promise<boolean> => {
        if (!groupsAvailable.enabled) return false;
        const owns = chat.captureOwner(), created = participantsEditor === 'create', returning = participantReturn.current;
        const ok = await (created ? chat.newChat(ids) : chat.configureParticipants(ids));
        if (ok && owns() && created) {if (returning && returning === participantReturn.current) returning.created = true; setFileError(''); setPreview(undefined); setListOpen(false);}
        return ok;
    };
    const returning = participantReturn.current;
    const closeParticipants = (): void => {
        if (returning !== participantReturn.current) return;
        const current = liveParticipantScope.current, owns = returning?.owns ?? chat.captureOwner();
        if (navigation && owns() && returning === participantReturn.current && returning?.root === current.root && (returning.scope === current.scope || returning.created)) {
            participantFocus.current = {scope: current.scope, owns, trigger: returning.trigger};
        }
        participantReturn.current = undefined; setParticipantsEditor(undefined);
    };
    const openParticipants = (mode: 'create' | 'edit', trigger: HTMLElement): void => {
        participantReturn.current = {scope: participantScope, root: participantRoot, trigger, owns: chat.captureOwner()}; setParticipantsEditor(mode);
    };
    const editor = participantsEditor && projectId ? <ChatParticipantsEditor key={`${participantsEditor}:${chat.detail?.conversation.id || 'new'}`} modelId={model.id} projectId={projectId}
        participants={participantsEditor === 'edit' ? chat.detail?.participants ?? [] : undefined} joining={participantsEditor === 'edit' && !group} inline={!!navigation} saving={chat.activity === 'saving'} error={chat.error} onSave={saveParticipants} onClose={closeParticipants}/> : null;
    return <Modal open centered width={1280} className={`model-chat${navigation?' model-chat_global model-chat_workspace':''}`} title={<div className="model-chat__title">{navigation ? 'Чат' : `Чат · ${model.name}`}<Typography.Text type="secondary">{projectName ? `Проект «${projectName}»` : 'Общий каталог'}</Typography.Text></div>}
        onCancel={close} footer={null} destroyOnClose>
        {navigation && <div className={'model-chat__configuration' + (!configurationOpen ? ' model-chat__configuration_collapsed' : '')}>
            <div className="model-chat__configuration-summary"><Button type="text" size="small" aria-label="Настройки чата: проект, модель и режим" aria-expanded={configurationOpen} aria-controls="model-chat-configuration"
                onClick={() => setConfiguration({id: chat.detail?.conversation.id, open: !configurationOpen})}>Настройки <span aria-hidden="true">{configurationOpen ? '▴' : '▾'}</span></Button>
                <Typography.Text type="secondary" className="model-chat__configuration-scope" title={model.name}>{`${group ? 'С участниками' : 'Личный диалог'} · ${model.name}`}</Typography.Text></div>
            <div id="model-chat-configuration">{navigation.controls(action => confirm(action, 'Открыть другой рабочий контекст?'))}</div>
        </div>}
        <div className={'model-chat__layout' + (listOpen ? ' model-chat__layout_list-open' : '')}>
            <aside id="model-chat-conversations" className="model-chat__sidebar"><ConversationList items={navigation?.items ?? chat.items} selected={chat.detail?.conversation.id} disabled={!!navigation?.opening || !!chat.activity && !chat.busy} loading={navigation?.loading || chat.activity === 'loading'}
                onSelect={select} onNew={newChat} onRefresh={() => {void chat.refresh(); navigation?.onRefresh();}}/>
                {navigation?.error&&<Alert type="error" showIcon message={navigation.error}/>}</aside>
            <main className="model-chat__main">
                <div className="model-chat__scope"><div className="model-chat__dialog-title"><Typography.Text strong title={chat.detail?.conversation.title || 'Новый диалог'}>{chat.detail?.conversation.title || 'Новый диалог'}</Typography.Text>{!navigation && <Typography.Text type="secondary">{model.model}</Typography.Text>}</div>
                    <Space size={4}><Button className="model-chat__mobile-menu" icon={<MenuOutlined/>} aria-expanded={listOpen} aria-controls="model-chat-conversations" onClick={() => setListOpen(!listOpen)}>Диалоги</Button>
                        <Tooltip title="Действия диалога" placement="bottom" trigger={['hover','focus']} open={actionsOpen ? false : undefined}><span className="model-chat__action-tooltip"><Dropdown autoFocus trigger={['click']} placement="bottomRight" open={actionsOpen} onOpenChange={setActionsOpen} dropdownRender={menu => <div onKeyDownCapture={closeActionsOnEscape}>{menu}</div>} menu={{onClick: () => setActionsOpen(false), items: [
                            {key: 'new', label: 'Новый диалог', icon: <PlusOutlined/>, disabled: !newConversationAvailable.enabled || !!chat.activity && !chat.busy, onClick: newChat},
                            {key: 'rename', label: 'Переименовать', icon: <EditOutlined/>, disabled: !chat.detail || !!chat.activity || chat.busy, onClick: () => {setTitle(chat.detail?.conversation.title || ''); setRenaming(true);}},
                            {key: 'delete', label: 'Удалить диалог', icon: <DeleteOutlined/>, danger: true, disabled: !chat.detail || !!chat.activity || chat.busy, onClick: remove},
                        ]}}><Button ref={actionTrigger} className="model-chat__icon-action" type="text" icon={<MoreOutlined/>} aria-label="Действия диалога" aria-haspopup="menu" aria-expanded={actionsOpen} onKeyDown={closeActionsOnEscape}/></Dropdown></span></Tooltip></Space>
                </div>
                <div ref={metadata} className="model-chat__metadata">
                {projectId && group && <div className="model-chat__group-bar">
                    <details className="model-chat__group-details"><summary ref={participantSummary}>Участники · {chat.detail?.participants?.length ?? 0}</summary>
                        <div className="model-chat__group-roster">
                        <Typography.Text type="secondary">{chat.detail?.participants?.map(agent => `${agent.name}${agent.status === 'active' ? ' · доступен для запросов' : ({disabled: ' · отключён', removed: ' · удалён', blocked: ' · недоступен'})[agent.status]}`).join(', ') || 'не выбраны'}</Typography.Text>
                        <FeatureButton features={['group_chat']} size="small" icon={<TeamOutlined/>} disabled={!!chat.activity || chat.busy} onClick={event => openParticipants('edit', event.currentTarget)}>Изменить участников</FeatureButton>
                        </div>
                    </details>
                </div>}
                {projectId && !group && <div className="model-chat__group-bar"><FeatureButton features={['group_chat']} size="small" icon={<TeamOutlined/>} disabled={!!chat.activity || chat.busy || !!navigation?.opening} onClick={event => openParticipants(chat.detail ? 'edit' : 'create', event.currentTarget)}>Участники</FeatureButton></div>}
                <ChatProjectContext evidence={projectId && searchAvailable.known && !searchAvailable.enabled ? {status:'metadata',sources:[],project:chat.detail?.projectContext?.project,
                    message:'Поиск по проекту выключен. Модель получит сведения о проекте и переписку без новых фрагментов из базы знаний.'} : chat.detail?.projectContext}/>
                </div>
                {chat.blocked && <Alert type="warning" showIcon message={chat.blocked} className="model-chat__notice"/>}
                {(chat.error || fileError) && <Alert type="error" showIcon message={fileError || chat.error} className="model-chat__notice"/>}
                {navigation && editor ? <div className="model-chat__inline-editor">{editor}</div> : <>
                <FeatureAvailabilityNotice features={[group ? 'group_chat' : 'model_chat']}/>
                {chat.activity === 'loading' && !chat.detail ? <div className="model-chat__loading" role="status"><Spin tip="Загружаем личные диалоги…"/></div>
                    : <ChatMessages key={chat.detail?.conversation.id || 'new'} turns={chat.turns} attachments={chat.detail?.attachments ?? []} modelName={model.name} conversationId={chat.detail?.conversation.id} blocked={!!chat.blocked} busy={!!chat.activity} group={group}
                        onRetry={chat.retry} onEdit={() => {void edit();}} onPreview={setPreview} hasEarlier={chat.detail?.history?.hasMore ?? false} historyLoading={chat.historyLoading} historyError={chat.historyError} onLoadEarlier={() => {void chat.loadEarlier();}} onComplete={() => {void chat.complete();}}/>}
                <ChatAttachments files={chat.attachments} uploads={chat.uploads} disabled={!!chat.activity || unresolved} onPreview={setPreview} onRemove={id => {void chat.removeAttachment(id);}}
                    onRetryUpload={chat.retryUpload} onRemoveUpload={chat.removeUpload}/>
                <div className={'model-chat__tools' + (research.enabled ? ' model-chat__tools_research-open' : '')}>
                    <ChatContextMeter context={context.context} loading={context.loading} error={context.error} rejected={context.rejected} usage={lastAnswer?.usage} compaction={chat.detail?.compaction} phase={lastTurn?.status === 'pending' || lastTurn?.status === 'failed' ? lastTurn.processingStage : undefined} failed={lastTurn?.status === 'failed'}/>
                    <ChatResearchControls value={research} disabled={disabled} projectId={projectId}/>
                </div>
                <ChatComposer draft={draft} disabled={disabled} canSend={!disabled && !chat.uploads.length && !contextBlocked && !researchBlocked && (!!draft.trim() || !!chat.attachments.length)}
                    sending={chat.busy} uploading={chat.activity === 'uploading'} onDraft={setDraft} onSend={send} onStop={() => {void chat.stop();}} onCancelUpload={chat.cancelUploads}
                    onFiles={files => {if(availability.enabled){setFileError(''); chat.addFiles(files);}}} onReject={setFileError} participants={group ? chat.detail?.participants ?? [] : undefined}/>
                </>}
            </main>
            {listOpen && <Button className="model-chat__mobile-list-close" onClick={() => setListOpen(false)}>Вернуться к чату</Button>}
        </div>
        {preview && chat.detail && <AttachmentPreview key={`${chat.detail.conversation.id}:${preview}`} conversationId={chat.detail.conversation.id} attachmentId={preview} onClose={() => setPreview(undefined)}/>}
        {!navigation && editor}
        <Modal open={renaming} title="Название диалога" onCancel={() => setRenaming(false)} okText="Сохранить" cancelText="Отмена" confirmLoading={chat.activity === 'saving'}
            okButtonProps={{disabled: !title.trim() || title.trim().length > 128 || !!chat.activity}} onOk={() => {const owns = chat.captureOwner(); void chat.rename(title.trim()).then(ok => {if (ok && owns()) setRenaming(false);});}}>
            <div className="model-chat__rename-fields">{chat.error && <Alert type="error" message={chat.error}/>}<Input autoFocus aria-label="Название диалога" value={title} maxLength={128} onChange={event => setTitle(event.target.value)}/></div>
        </Modal>
    </Modal>;
}
