import {Alert, Button, Input, Select, Typography} from 'antd';
import {SendOutlined} from '@ant-design/icons';
import {useEffect, useRef, useState} from 'react';
import type {TextAreaRef} from 'antd/lib/input/TextArea';
import {errorMessage} from '../../common/utils/errorMessage';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {emptyProjectChatDraft, PROJECT_CHAT_MESSAGE_BYTES, projectChatAmbiguous, projectChatAuthor, projectChatRequestKey} from './model';
import type {ProjectChatDetail, ProjectChatDraft, ProjectChatIntent, ProjectChatMessage, ProjectChatReceipt} from './types';

const drafts = new Map<string, ProjectChatDraft>();
interface Props {
    draftKey: string; detail: ProjectChatDetail; reply?: ProjectChatMessage;
    onCancelReply: () => void; onFrozenChange?: (value: boolean) => void;
    onSend: (intent: ProjectChatIntent) => Promise<ProjectChatReceipt>;
}

/** A shared-room post gets a short durable receipt; other questions can arrive while agents work. */
export function ProjectChatComposer({draftKey, detail, reply, onCancelReply, onFrozenChange, onSend}: Props): JSX.Element {
    const {captureOwner} = useAuthRequestOwner(), availability = useFeatureAvailability('project_chat'), inference = useFeatureAvailability('group_chat');
    const [draft, setDraft] = useState<ProjectChatDraft>(() => drafts.get(draftKey) ?? emptyProjectChatDraft());
    const [sending, setSending] = useState(false), [error, setError] = useState('');
    const latest = useRef(draft), lock = useRef(false), text = useRef<TextAreaRef>(null), alive = useRef(true);
    latest.current = draft;
    const frozen = sending || !!draft.pending;
    const update = (value: ProjectChatDraft): void => {latest.current = value; drafts.set(draftKey, value); setDraft(value);};
    useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
    useEffect(() => {onFrozenChange?.(frozen);}, [frozen, onFrozenChange]);
    useEffect(() => {
        if (!reply || latest.current.pending || lock.current) return;
        update({...latest.current, reply, delivery: 'people', agentIds: []}); setError(''); text.current?.focus();
    }, [reply?.id]);
    const selectedReply = draft.pending?.replyToId ? draft.reply : draft.reply ?? reply;
    const targets = draft.delivery === 'people' ? [] : draft.delivery === 'group' ? detail.room.agentIds : draft.agentIds;
    const unavailable = targets.find(id => detail.agents.find(agent => agent.agentId === id)?.status !== 'active');
    const recipients = targets.map(id => detail.agents.find(agent => agent.agentId === id)?.name ?? 'Недоступный агент');
    const send = async (): Promise<void> => {
        const owns = captureOwner();
        if (lock.current || !owns() || !draft.pending && (!detail.canPost || !availability.enabled)) return;
        if (!draft.pending && !draft.body.trim()) {setError('Напишите сообщение.'); text.current?.focus(); return;}
        if (!draft.pending && new TextEncoder().encode(draft.body.trim()).length > PROJECT_CHAT_MESSAGE_BYTES) {setError('Сообщение слишком большое: допустимо до 128 КиБ текста UTF-8. Сократите его.'); return;}
        if (!draft.pending && draft.delivery !== 'people' && (!inference.enabled || !targets.length || unavailable)) {
            setError(!inference.enabled ? inference.reason : !targets.length ? 'Выберите доступного агента или отправьте сообщение только людям.' : 'Среди адресатов есть недоступный агент. Измените выбор или отправьте только людям.'); return;
        }
        const intent = draft.pending ?? {requestKey: projectChatRequestKey(), prompt: draft.body.trim(), ...(selectedReply ? {replyToId: selectedReply.id} : {}), targetAgentIds: [...targets]};
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
        <Input.TextArea ref={text} aria-label="Текст сообщения команде" value={draft.body} autoSize={{minRows: 2, maxRows: 8}} disabled={frozen || !detail.canPost || !availability.enabled}
            placeholder={detail.canPost ? 'Напишите участникам проекта…' : 'Для отправки нужна роль разработчика проекта.'} onChange={event => {update({...draft, body: event.target.value}); setError('');}}
            onKeyDown={event => {if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {event.preventDefault(); void send();}}}/>
        <div className="project-chat__delivery"><label>Кому<Select aria-label="Адресаты сообщения" value={draft.delivery} disabled={frozen || !detail.canPost || !availability.enabled} options={[
            {value: 'people', label: 'Только участникам проекта'}, {value: 'group', label: 'Участникам и всем агентам группы'}, {value: 'selected', label: 'Участникам и выбранным агентам'},
        ]} onChange={delivery => {
            const agentIds = delivery === 'selected' && !draft.agentIds.length && selectedReply?.agent ? [selectedReply.agent.id] : draft.agentIds;
            update({...draft, delivery, agentIds}); setError('');
        }}/></label>
            {draft.delivery === 'selected' && <label>Агенты<Select mode="multiple" aria-label="Агенты для ответа" value={draft.agentIds} disabled={frozen || !detail.canPost || !availability.enabled || !inference.enabled} optionFilterProp="label" placeholder="Выберите агентов" options={detail.agents.filter(agent => detail.room.agentIds.includes(agent.agentId)).map(agent => ({value: agent.agentId, label: agent.name, disabled: agent.status !== 'active'}))}
                onChange={agentIds => {update({...draft, agentIds}); setError('');}}/></label>}
        </div>
        <Typography.Text type="secondary" className="project-chat__delivery-note" role="status">{draft.delivery === 'people' ? 'Увидят участники проекта. Запрос к моделям не выполняется.' : `${recipients.length ? recipients.join(', ') : 'Выберите агентов'}. Каждый отвечает по своей специализации; запросов к моделям: ${targets.length}. Итог собирается из ответов.`}</Typography.Text>
        {draft.pending && <Alert showIcon type="warning" message="Подтверждение отправки не получено" description="Повторите тот же запрос. Текст, ответ на сообщение и адресаты зафиксированы; второй вопрос не создаётся."/>}
        {error && <Alert role="alert" type="error" showIcon message={error}/>}
        {!availability.enabled && <Typography.Paragraph type="secondary">{availability.reason}</Typography.Paragraph>}
        {draft.delivery !== 'people' && !inference.enabled && <Typography.Paragraph type="secondary">{inference.reason} Можно выбрать «Только участникам проекта».</Typography.Paragraph>}
        <div className="project-chat__send"><Typography.Text type="secondary">Enter — отправить · Shift+Enter — новая строка</Typography.Text><Button type="primary" icon={<SendOutlined aria-hidden/>} loading={sending} disabled={sending || !draft.pending && (!detail.canPost || !availability.enabled)} onClick={() => {void send();}}>{draft.pending ? 'Проверить отправку' : draft.delivery === 'people' ? 'Отправить' : 'Спросить агентов'}</Button></div>
    </section>;
}
