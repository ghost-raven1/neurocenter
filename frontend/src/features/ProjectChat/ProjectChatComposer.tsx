import {Alert, Button, Mentions, Select, Typography} from 'antd';
import {SendOutlined} from '@ant-design/icons';
import {useEffect, useRef, useState} from 'react';
import type {MentionsRef} from 'antd/lib/mentions';
import {errorMessage} from '../../common/utils/errorMessage';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {chatMentions} from '../ModelChat/participants';
import {chatSystemRoleMention, chatSystemRoleOptions} from '../ChatSystemRoles/mentions';
import {chatRoleOriginKey, type ChatRoleLaunch} from '../ChatSystemRoles/types';
import type {SystemRoleId} from '../SystemRoles/types';
import {emptyProjectChatDraft, PROJECT_CHAT_MESSAGE_BYTES, projectChatAmbiguous, projectChatAuthor, projectChatRequestKey} from './model';
import type {ProjectChatDetail, ProjectChatDraft, ProjectChatIntent, ProjectChatMessage, ProjectChatReceipt} from './types';
import {ProjectChatPanel} from './ProjectChatPanel';

const drafts = new Map<string, ProjectChatDraft>();
interface Props {
    draftKey: string; detail: ProjectChatDetail; reply?: ProjectChatMessage;
    onCancelReply: () => void; onFrozenChange?: (value: boolean) => void;
    onTyping?: (body: string) => void;
    onSend: (intent: ProjectChatIntent) => Promise<ProjectChatReceipt>;
    onSystemRole?: (launch: ChatRoleLaunch) => void;
}

/** A shared-room post gets a short durable receipt; other questions can arrive while agents work. */
export function ProjectChatComposer({draftKey, detail, reply, onCancelReply, onFrozenChange, onTyping, onSend, onSystemRole}: Props): JSX.Element {
    const {captureOwner} = useAuthRequestOwner(), availability = useFeatureAvailability('project_chat'), inference = useFeatureAvailability('group_chat');
    const [draft, setDraft] = useState<ProjectChatDraft>(() => drafts.get(draftKey) ?? emptyProjectChatDraft());
    const [sending, setSending] = useState(false), [error, setError] = useState('');
    const [recipientsOpen, setRecipientsOpen] = useState(false);
    const latest = useRef(draft), lock = useRef(false), text = useRef<MentionsRef>(null), alive = useRef(true), composing = useRef(false);
    const roleSequence = useRef(0);
    latest.current = draft;
    const frozen = sending || !!draft.pending;
    const dialogs = useFeatureAvailability('project_chat_dialogs'), custom = !!detail.room.id && detail.room.id !== '00000000-0000-0000-0000-000000000000';
    const canSend = availability.enabled && (!custom || dialogs.enabled), privateRoom = detail.room.visibility === 'PRIVATE';
    useEffect(() => {if (frozen || !detail.canPost || !canSend) onTyping?.(''); return () => onTyping?.('');}, [onTyping, frozen, detail.canPost, canSend]);
    const audience = privateRoom ? 'Переписка видна только участникам этого диалога.' : 'Переписка видна участникам проекта.';
    const update = (value: ProjectChatDraft): void => {latest.current = value; drafts.set(draftKey, value); setDraft(value);};
    useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
    useEffect(() => {onFrozenChange?.(frozen);}, [frozen, onFrozenChange]);
    useEffect(() => {
        if (!reply || latest.current.reply?.id === reply.id || latest.current.pending || lock.current) return;
        update({...latest.current, reply, delivery: 'people', agentIds: []}); setError(''); text.current?.focus();
    }, [reply?.id]);
    const selectedReply = draft.pending?.replyToId ? draft.reply : draft.reply ?? reply;
    const roomAgents = detail.agents.filter(agent => detail.room.agentIds.includes(agent.agentId));
    const activeRoomAgents = roomAgents.filter(agent => agent.status === 'active');
    const agentsHelp = detail.canConfigure ? 'Откройте «Настроить агентов» или уберите @, чтобы написать участникам.' : 'Попросите администратора проекта добавить агентов или уберите @, чтобы написать участникам.';
    const emptyRoomText = `В группе нет агентов. ${agentsHelp}`;
    const role = onSystemRole && !draft.pending ? chatSystemRoleMention(draft.body, roomAgents) : undefined;
    const mentions = chatMentions(draft.body, roomAgents), explicit = mentions.hasMentions && !draft.pending && !role?.agentId && !role?.error;
    const mentionError = mentions.error && !roomAgents.length ? emptyRoomText : mentions.error;
    const targets = draft.pending ? draft.pending.targetAgentIds ?? [] : explicit ? mentions.ids : draft.delivery === 'people' ? [] : draft.delivery === 'group' ? detail.room.agentIds : draft.agentIds;
    const asksAgents = !role?.agentId && !role?.error && (targets.length > 0 || !draft.pending && (explicit || draft.delivery !== 'people'));
    const unavailable = targets.find(id => roomAgents.find(agent => agent.agentId === id)?.status !== 'active');
    const recipients = targets.map(id => detail.agents.find(agent => agent.agentId === id)?.name ?? 'Недоступный агент');
    const recovering = !!draft.pending && !sending;
    const feedback = recovering || !!error || !!role?.error || !canSend || asksAgents && !inference.enabled && !draft.pending;
    const openSystemRole = (agentId: SystemRoleId, instruction: string): void => {
        const owns = captureOwner(), source = latest.current;
        if (!onSystemRole || frozen || !owns()) return;
        const origin = chatRoleOriginKey({kind: 'project-chat', originId: detail.room.id ?? '00000000-0000-0000-0000-000000000000', projectId: detail.room.projectId});
        onTyping?.('');
        onSystemRole({key: ++roleSequence.current, origin, agentId, instruction, ...(detail.room.modelId ? {modelId: detail.room.modelId} : {}),
            onAccepted: () => {if (owns() && alive.current && latest.current === source) {update(emptyProjectChatDraft()); drafts.delete(draftKey); onCancelReply();}}});
    };
    const send = async (): Promise<void> => {
        const owns = captureOwner();
        if (lock.current || !owns() || !draft.pending && (!detail.canPost || !canSend)) return;
        if (!draft.pending && !draft.body.trim()) {setError('Напишите сообщение.'); text.current?.focus(); return;}
        if (!draft.pending && role?.error) {setError(role.error); return;}
        if (!draft.pending && role?.agentId) {openSystemRole(role.agentId, role.instruction); return;}
        if (!draft.pending && new TextEncoder().encode(draft.body.trim()).length > PROJECT_CHAT_MESSAGE_BYTES) {setError('Сообщение слишком большое: допустимо до 128 КиБ текста UTF-8. Сократите его.'); return;}
        if (!draft.pending && explicit && mentionError) {setError(mentionError); text.current?.focus(); return;}
        if (!draft.pending && asksAgents && (!inference.enabled || !targets.length || unavailable)) {
            setError(!inference.enabled ? inference.reason : !targets.length ? 'Выберите доступного агента или отправьте сообщение только людям.' : 'Среди адресатов есть недоступный агент. Измените выбор или отправьте только людям.'); return;
        }
        const intent = draft.pending ?? {requestKey: projectChatRequestKey(), prompt: draft.body.trim(), ...(selectedReply ? {replyToId: selectedReply.id} : {}), targetAgentIds: [...targets]};
        onTyping?.('');
        lock.current = true; update({...draft, reply: selectedReply, pending: intent}); setSending(true); setError('');
        try {
            await onSend(intent);
            if (!owns() || !alive.current) return;
            update(emptyProjectChatDraft()); drafts.delete(draftKey); onCancelReply(); text.current?.focus();
        } catch (cause) {
            if (!owns() || !alive.current) return;
            if (!projectChatAmbiguous(cause)) update({...latest.current, pending: undefined});
            setError(errorMessage(cause, 'Отправка не подтверждена. Повторите этот запрос: текст и адресаты сохранены.'));
        } finally {lock.current = false; if (owns() && alive.current) setSending(false);}
    };
    return <section className="project-chat__composer" aria-label="Сообщение команде проекта">
        {selectedReply && <div className="project-chat__reply-draft"><div><Typography.Text strong>Ответ · {projectChatAuthor(selectedReply)}</Typography.Text><div>{selectedReply.content.slice(0, 220) || 'Сообщение ещё готовится'}</div></div>
            <Button size="small" disabled={frozen} onClick={() => {update({...draft, reply: undefined}); onCancelReply(); text.current?.focus();}}>Отменить ответ</Button></div>}
        <div className="project-chat__composer-heading"><label htmlFor="project-chat-message">Сообщение</label>
            {onSystemRole && <Button type="text" size="small" disabled={frozen || !detail.canPost || !canSend} onClick={() => openSystemRole('agent-coordinator', draft.body)}>Системный агент</Button>}
            <ProjectChatPanel label="Кому отправить сообщение" caption={explicit ? 'Кому: по @упоминаниям' : draft.delivery === 'people' ? 'Кому: участникам' : 'Кому: участникам и агентам'} open={recipientsOpen} onOpenChange={setRecipientsOpen} placement="topRight">
                <div className="project-chat__delivery"><label>Кому<Select aria-label="Адресаты сообщения" value={draft.delivery} disabled={frozen || explicit || !detail.canPost || !canSend} options={[
                    {value: 'people', label: privateRoom ? 'Только участникам диалога' : 'Только участникам проекта'}, {value: 'group', label: 'Участникам и всем агентам группы'}, {value: 'selected', label: 'Участникам и выбранным агентам'},
                ]} onChange={delivery => {
                    const replyAgent = roomAgents.find(agent => agent.agentId === selectedReply?.agent?.id && agent.status === 'active');
                    const agentIds = delivery === 'selected' && !draft.agentIds.length && replyAgent ? [replyAgent.agentId] : draft.agentIds;
                    update({...draft, delivery, agentIds}); setError('');
                }}/></label>
                    {draft.delivery === 'selected' && <label>Агенты<Select mode="multiple" aria-label="Агенты для ответа" value={draft.agentIds} disabled={frozen || explicit || !detail.canPost || !canSend || !inference.enabled} optionFilterProp="label" placeholder="Выберите агентов" options={roomAgents.map(agent => ({value: agent.agentId, label: agent.name, disabled: agent.status !== 'active'}))}
                        onChange={agentIds => {update({...draft, agentIds}); setError('');}}/></label>}
                    <Typography.Text type="secondary">{audience} Явные @упоминания заменяют выбор «Кому». Каждый выбранный агент получает отдельный запрос; итог собирается из их ответов.</Typography.Text>
                </div>
            </ProjectChatPanel>
        </div>
        <Mentions ref={text} id="project-chat-message" aria-label="Текст сообщения команде" aria-describedby="project-chat-recipients project-chat-keyboard-hint" value={draft.body} autoSize={{minRows: 1, maxRows: 4}} disabled={frozen || !detail.canPost || !canSend} placement="top" dropdownClassName="project-chat__mentions"
            placeholder={detail.canPost ? 'Напишите участникам или @имя, чтобы спросить агента…' : 'Для отправки нужна роль разработчика проекта.'} onChange={body => {update({...draft, body}); setError(''); onTyping?.(body);}} onBlur={() => onTyping?.('')}
            options={[...(inference.enabled ? activeRoomAgents.map(agent => ({value: agent.slug, label: `${agent.name} · @${agent.slug}`})) : []), ...(onSystemRole ? chatSystemRoleOptions : [])]}
            notFoundContent={!inference.enabled ? inference.reason : !activeRoomAgents.length ? `Нет доступных агентов. ${agentsHelp}` : 'Агент не найден. Измените имя.'}
            filterOption={(search, option) => `${option.value} ${chatSystemRoleOptions.find(role => role.value === option.value)?.label ?? ''} ${roomAgents.find(agent => agent.slug === option.value)?.name ?? ''}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))}
            onCompositionStart={() => {composing.current = true;}} onCompositionEnd={() => {composing.current = false;}}
            onPressEnter={event => {if (!event.defaultPrevented && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {event.preventDefault(); void send();}}}/>
        <Typography.Text id="project-chat-recipients" type={explicit && mentionError ? 'warning' : 'secondary'} className="project-chat__delivery-note" role="status">{role?.agentId || role?.error ? 'Системная задача не публикуется в переписку участников.' : explicit ? mentionError ? `${mentionError} @ заменяет выбор «Кому».` : `Ответят: ${recipients.join(', ')} · запросов к моделям: ${targets.length}. @ заменяет выбор «Кому». ${privateRoom ? 'Только участники диалога.' : 'Весь проект.'}` : !asksAgents ? `${privateRoom ? 'Увидят только участники диалога' : 'Увидят участники проекта'}. Запрос к моделям не выполняется.` : `${recipients.length ? recipients.join(', ') : 'Выберите агентов'} · запросов к моделям: ${targets.length}. ${privateRoom ? 'Увидят только участники диалога.' : 'Увидят участники проекта.'}`}</Typography.Text>
        {role?.agentId && <Typography.Text type="secondary" role="status">Сначала проверим задачу, модель и контекст. Результат системного агента будет виден только вам.</Typography.Text>}
        {feedback && <div className="project-chat__feedback" role="region" aria-label="Состояние отправки" tabIndex={0}>
            {recovering ? <Alert role="alert" showIcon type="warning" message={error || 'Подтверждение отправки не получено'} description="Проверьте ту же отправку: текст, ответ на сообщение и адресаты сохранены."/>
                : (error || role?.error) && <Alert role="alert" type="error" showIcon message={error || role?.error}/>}
            {!canSend && <Typography.Paragraph type="secondary">{availability.enabled && custom ? dialogs.reason : availability.reason}</Typography.Paragraph>}
            {asksAgents && !inference.enabled && !draft.pending && <Typography.Paragraph type="secondary">{inference.reason} {explicit ? 'Уберите @адресатов, чтобы отправить сообщение только людям.' : 'Можно выбрать «Только участникам проекта».'}</Typography.Paragraph>}
        </div>}
        <div className="project-chat__send"><Typography.Text id="project-chat-keyboard-hint" className="project-chat__keyboard-hint" type="secondary">Enter — отправить · Shift+Enter — новая строка</Typography.Text><Button type="primary" icon={<SendOutlined aria-hidden/>} loading={sending} disabled={sending || !draft.pending && (!detail.canPost || !canSend || !!role?.error || explicit && !!mentionError)} onClick={() => {void send();}}>{recovering ? 'Проверить отправку' : role?.agentId ? 'Подготовить задачу' : asksAgents ? 'Спросить агентов' : 'Отправить'}</Button></div>
    </section>;
}
