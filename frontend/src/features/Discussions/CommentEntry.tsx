import {Alert, Avatar, Button, Input, Popconfirm, Space, Typography} from 'antd';
import {FileOutlined, UserOutlined} from '@ant-design/icons';
import {useRef, useState} from 'react';
import {isAxiosError} from 'axios';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {discussionsApi} from './api';
import {attachmentUrl, fileSize, MAX_COMMENT_BODY_BYTES} from './model';
import {SafeMarkdown} from './SafeMarkdown';
import type {DiscussionComment} from './types';

interface Props {comment: DiscussionComment; parent?: DiscussionComment; canReply: boolean; onReply: () => void; onSaved: (value: DiscussionComment) => void; onRemoved: () => void; onDenied?: () => void}
const time = (value: string): string => Number.isNaN(Date.parse(value)) ? '' : new Date(value).toLocaleString('ru-RU');

/** Edits require explicit revision review after a conflict or missing acknowledgement. */
export function CommentEntry({comment, parent, canReply, onReply, onSaved, onRemoved, onDenied}: Props): JSX.Element {
    const {captureOwner} = useAuthRequestOwner(), availability = useFeatureAvailability('discussions');
    const [editing, setEditing] = useState(false), [draft, setDraft] = useState(comment.body), [baseVersion, setBaseVersion] = useState(comment.version);
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [review, setReview] = useState(false), [latest, setLatest] = useState<DiscussionComment>();
    const lock = useRef(false), operation = useRef<'edit' | 'remove'>();
    const check = async (): Promise<void> => {
        const owns = captureOwner(); if (!owns() || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {const value = await discussionsApi.get(comment.id); if (owns()) {
            setLatest(value); onSaved(value);
            if (value.deleted || operation.current === 'edit' && value.body === draft.trim()) {setReview(false); setError(''); setEditing(false); setBaseVersion(value.version);}
        }}
        catch (cause) {if (owns()) {if (isAxiosError(cause) && [401, 403, 404].includes(cause.response?.status ?? 0)) onDenied?.(); setError(errorMessage(cause, 'Не удалось проверить комментарий. Ваш текст сохранён.'));}}
        finally {lock.current = false; if (owns()) setBusy(false);}
    };
    const mutate = async (remove: boolean): Promise<void> => {
        const owns = captureOwner();
        if (!owns() || lock.current || review || !remove && (!availability.enabled || !draft.trim())) return;
        if (!remove && new TextEncoder().encode(draft.trim()).length > MAX_COMMENT_BODY_BYTES) {setError('Текст слишком большой: допустимо до 16 000 байт UTF-8.'); return;}
        lock.current = true; operation.current = remove ? 'remove' : 'edit'; setBusy(true); setError('');
        try {
            if (remove) {await discussionsApi.remove(comment.id, comment.version); if (owns()) onRemoved();}
            else {const saved = await discussionsApi.edit(comment.id, draft.trim(), baseVersion); if (owns()) {onSaved(saved); setDraft(saved.body); setBaseVersion(saved.version); setEditing(false);}}
        } catch (cause) {
            if (owns()) {
                const status = isAxiosError(cause) ? cause.response?.status : undefined;
                if (status && [401, 403, 404].includes(status)) onDenied?.();
                if (status === undefined || status >= 500 || status === 408 || status === 409) {setReview(true); setLatest(undefined);}
                setError(errorMessage(cause, 'Изменение не подтверждено. Проверьте актуальный комментарий; ваш текст сохранён.'));
            }
        } finally {lock.current = false; if (owns()) setBusy(false);}
    };
    return <article className={'discussion-entry' + (comment.parentId ? ' discussion-entry_reply' : '')} id={'comment-' + comment.id} aria-label={'Комментарий ' + (comment.author.displayName || comment.author.email)}>
        <Avatar size="small" icon={<UserOutlined/>}/><div className="discussion-entry__content">
            <header><Typography.Text strong>{comment.author.displayName || comment.author.email}</Typography.Text><time dateTime={comment.createdAt}>{time(comment.createdAt)}</time>{comment.updatedAt !== comment.createdAt && !comment.deleted && <Typography.Text type="secondary">изменён</Typography.Text>}</header>
            {comment.parentId && <div className="discussion-entry__parent">Ответ <a href={'#comment-' + comment.parentId}>{parent?.author.displayName || parent?.author.email || 'на комментарий'}</a></div>}
            {comment.deleted ? <Typography.Paragraph type="secondary">Комментарий удалён</Typography.Paragraph> : editing ? <Input.TextArea aria-label="Изменённый комментарий" autoSize={{minRows: 3, maxRows: 10}} maxLength={8000} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)}/> : <SafeMarkdown body={comment.body}/>}
            {!comment.deleted && comment.attachments.length > 0 && <ul className="discussion-entry__attachments">{comment.attachments.map(file => {
                const url = attachmentUrl(file.url);
                return <li key={file.id}><FileOutlined/> {url ? <a href={url} download={file.name}>{file.name}</a> : <span>{file.name} (ссылка недоступна)</span>} <small>{fileSize(file.bytes)}</small></li>;
            })}</ul>}
            {error && <Alert role="alert" type="error" showIcon message={error}/>}
            {review && <Alert type="warning" showIcon message="Проверьте актуальную версию перед повтором" description={<Space direction="vertical">
                <Button size="small" loading={busy} onClick={() => {void check();}}>Проверить комментарий</Button>
                {latest && (latest.deleted ? <Typography.Text>Удаление подтверждено.</Typography.Text> : <>
                    <SafeMarkdown body={latest.body}/>
                    {latest.body === draft.trim() && editing && <Typography.Text>Ваш текст уже сохранён.</Typography.Text>}
                    <Button size="small" disabled={busy || !(operation.current === 'remove' ? latest.canDelete : latest.canEdit)} onClick={() => {setBaseVersion(latest.version); setReview(false); setError('');}}>{operation.current === 'remove' ? 'Вернуться к удалению этой версии' : 'Продолжить с этой версией, сохранив мой текст'}</Button>
                </>)}
            </Space>}/>}
            {!comment.deleted && <Space size={4} wrap className="discussion-entry__actions">
                {editing ? <><Button size="small" type="primary" loading={busy} disabled={busy || review || !availability.enabled || !draft.trim()} onClick={() => {void mutate(false);}}>Сохранить</Button><Button size="small" disabled={busy} onClick={() => setEditing(false)}>Закрыть редактор</Button></> : <>
                    <Button size="small" type="text" disabled={!canReply || !availability.enabled} onClick={onReply}>Ответить</Button>
                    {comment.canEdit && <Button size="small" type="text" disabled={busy || !availability.enabled} onClick={() => setEditing(true)}>Изменить</Button>}
                </>}
                {comment.canDelete && <Popconfirm title="Удалить комментарий? Ответы останутся в обсуждении." okText="Удалить" cancelText="Отмена" onConfirm={() => {void mutate(true);}} disabled={busy || review}>
                    <Button size="small" type="text" danger disabled={busy || review}>Удалить</Button>
                </Popconfirm>}
            </Space>}
        </div>
    </article>;
}
