import {Alert, Button, Input, Modal, Select, Space, Typography} from 'antd';
import {useEffect, useRef, useState} from 'react';
import {isAxiosError} from 'axios';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {projectChatAmbiguous, projectChatRequestKey} from './model';
import type {ProjectChatCreateRoom, ProjectChatMember, ProjectChatRoomSummary, ProjectChatUpdateRoom, ProjectChatVisibility} from './types';

const drafts = new Map<string, {title: string; visibility: ProjectChatVisibility; memberEmails: string[]; pending?: ProjectChatCreateRoom; baseline?: ProjectChatRoomSummary; needsReview?: boolean}>();
interface Props {
    draftKey: string;
    room?: ProjectChatRoomSummary; members: ProjectChatMember[]; onClose: () => void;
    onCreate: (input: ProjectChatCreateRoom) => Promise<ProjectChatRoomSummary>;
    onUpdate: (id: string, input: ProjectChatUpdateRoom) => Promise<ProjectChatRoomSummary>;
    onCompare: (id: string) => Promise<ProjectChatRoomSummary>;
}

/** Explicit people define a private audience; changing its name never changes visibility. */
export function ProjectChatDialogForm({draftKey, room, members, onClose, onCreate, onUpdate, onCompare}: Props): JSX.Element {
    const {captureOwner} = useAuthRequestOwner(), flag = useFeatureAvailability('project_chat_dialogs');
    const key = JSON.stringify([draftKey, room?.id ?? 'new']), saved = drafts.get(key);
    const [name, setName] = useState(saved?.title ?? room?.title ?? ''), [visibility, setVisibility] = useState<ProjectChatVisibility>(saved?.visibility ?? room?.visibility ?? 'PUBLIC');
    const [emails, setEmails] = useState(saved?.memberEmails ?? room?.memberEmails ?? []), [saving, setSaving] = useState(false), [error, setError] = useState('');
    const [pending, setPending] = useState<ProjectChatCreateRoom | undefined>(saved?.pending), lock = useRef(false);
    const [baseline, setBaseline] = useState(saved?.baseline ?? room), [needsReview, setNeedsReview] = useState(saved?.needsReview ?? false), [comparison, setComparison] = useState<ProjectChatRoomSummary>(), [comparing, setComparing] = useState(false), alive = useRef(true);
    useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
    useEffect(() => {drafts.set(key, {title: name, visibility, memberEmails: emails, pending, baseline, needsReview});}, [key, name, visibility, emails, pending, baseline, needsReview]);
    const introductions = !baseline || name.trim() !== baseline.title || emails.some(email => !baseline.memberEmails.includes(email));
    const blocked = !pending && introductions && !flag.enabled;
    const save = async (): Promise<void> => {
        const owns = captureOwner(); if (!owns() || lock.current || blocked || needsReview || comparing) return;
        if (!name.trim() || name.trim().length > 120) {setError('Введите название от 1 до 120 символов.'); return;}
        lock.current = true; setSaving(true); setError('');
        const input = pending ?? {requestKey: projectChatRequestKey(), title: name.trim(), visibility, memberEmails: visibility === 'PRIVATE' ? emails : []};
        try {
            if (room) await onUpdate(room.id, {expectedRevision: baseline!.revision, title: name.trim(), memberEmails: visibility === 'PRIVATE' ? emails : []});
            else {setPending(input); await onCreate(input);}
            if (owns() && alive.current) {drafts.delete(key); onClose();}
        } catch (cause) {if (owns() && alive.current) {if (!projectChatAmbiguous(cause)) setPending(undefined); if (room && isAxiosError(cause) && cause.response?.status === 409) setNeedsReview(true); setError(errorMessage(cause, 'Действие не подтверждено. Значения сохранены; проверьте диалоги и повторите.'));}}
        finally {lock.current = false; if (owns() && alive.current) setSaving(false);}
    };
    const compare = async (): Promise<void> => {
        const owns = captureOwner(); if (!room || !owns() || lock.current) return;
        lock.current = true; setComparing(true); setError('');
        try {
            const fresh = await onCompare(room.id); if (!owns() || !alive.current) return;
            if (fresh.id !== room.id || fresh.visibility !== room.visibility) throw new Error('Сравнение относится к другому диалогу. Повторите чтение.');
            setBaseline(fresh); setComparison(fresh); setNeedsReview(false);
        } catch (cause) {if (owns() && alive.current) setError(errorMessage(cause, 'Сравнение не загружено. Введённые значения сохранены; повторите чтение.'));}
        finally {lock.current = false; if (owns() && alive.current) setComparing(false);}
    };
    const options = [...new Map([...members.map(member => ({value: member.email, label: `${member.displayName || member.email} · ${member.email}`})), ...emails.filter(email => !members.some(member => member.email === email)).map(email => ({value: email, label: `${email} · сохранённый участник`}))].map(option => [option.value, option])).values()];
    return <Modal title={room ? 'Настройки диалога' : 'Новый диалог'} open onCancel={onClose} footer={null} destroyOnClose>
        <Space direction="vertical" size={12} style={{width: '100%'}}>
            <label className="project-chat__dialog-field">Название<Input aria-label="Название диалога" value={name} maxLength={120} disabled={saving || !!pending} onChange={event => setName(event.target.value)} placeholder="Например, релиз или обсуждение дизайна"/></label>
            <label className="project-chat__dialog-field">Кто увидит переписку<Select aria-label="Доступ к диалогу" value={visibility} disabled={!!room || saving || !!pending} onChange={value => {setVisibility(value); if (value === 'PUBLIC') setEmails([]);}} options={[{value: 'PUBLIC', label: 'Весь проект — публичный диалог'}, {value: 'PRIVATE', label: 'Выбранные люди — приватный диалог'}]}/></label>
            {visibility === 'PRIVATE' && <label className="project-chat__dialog-field">Участники<Select mode="multiple" aria-label="Люди в приватном диалоге" value={emails} options={options} optionFilterProp="label" disabled={saving || !!pending} onChange={setEmails} placeholder="Выберите конкретных людей проекта"/></label>}
            <Typography.Paragraph type="secondary">{visibility === 'PUBLIC' ? 'Все участники проекта с правом чтения увидят сообщения и ответы агентов.' : 'Переписку и название увидят только создатель и выбранные люди, пока у них есть доступ к проекту. Создатель всегда сохраняет доступ. Администратор не добавляется автоматически.'} Доступ публичный или приватный выбирается при создании. История сохраняется.</Typography.Paragraph>
            {pending && <Alert type="warning" showIcon message="Создание не подтверждено" description="Повторите тот же запрос: название и участники зафиксированы; второй диалог не создаётся."/>}
            {blocked && <Alert type="info" showIcon message={flag.reason} description="Можно читать историю и убирать людей из приватного диалога."/>}
            {needsReview && <Alert type="warning" showIcon message="Диалог изменился" description="Сравните с текущими настройками перед сохранением. Ваши изменения остаются в полях выше."/>}
            {comparison && <Alert type="info" showIcon message={`Сейчас сохранено · ревизия ${comparison.revision}`} description={<div><div>Название: {comparison.title}</div><div>Участники: {comparison.visibility === 'PUBLIC' ? 'Весь проект' : comparison.memberEmails.join(', ')}</div><div>Ваши изменения остаются в полях выше. Проверьте различия и сохраните явно.</div></div>}/>}
            {error && <Alert type="error" role="alert" showIcon message={error} action={room ? <Button onClick={onClose}>К списку диалогов</Button> : undefined}/>}
            <Space wrap>{room && (needsReview || comparison) && <Button loading={comparing} disabled={saving || comparing} onClick={() => {void compare();}}>Сравнить с текущими</Button>}
                <Button type="primary" loading={saving} disabled={saving || comparing || blocked || needsReview} onClick={() => {void save();}}>{pending ? 'Проверить создание' : room ? 'Сохранить диалог' : 'Создать диалог'}</Button></Space>
        </Space>
    </Modal>;
}
