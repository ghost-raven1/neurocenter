import {Alert, Button, Input, Progress, Space, Tooltip, Typography} from 'antd';
import {PaperClipOutlined, SendOutlined} from '@ant-design/icons';
import {useEffect, useRef, useState} from 'react';
import type {TextAreaRef} from 'antd/lib/input/TextArea';
import {errorMessage} from '../../common/utils/errorMessage';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {discussionsApi} from './api';
import {ambiguousFailure, emptyDraft, fileSize, MAX_COMMENT_BODY_BYTES, MAX_COMMENT_BYTES, MAX_COMMENT_FILES, requestKey} from './model';
import type {DiscussionComment, DiscussionDraft, DiscussionTarget} from './types';

// File objects stay in memory while the drawer closes. They are never shared across actor/target keys.
const drafts = new Map<string, DiscussionDraft>();
interface Props {
    target: DiscussionTarget; draftKey: string; canComment: boolean; canAttach: boolean; attachmentsUnavailableReason?: string;
    reply?: DiscussionComment; onCancelReply: () => void; onSaved: (value: DiscussionComment) => void;
}

/** A missing ACK freezes its exact intent; retry cannot create a second comment or file. */
export function CommentComposer({target, draftKey, canComment, canAttach, attachmentsUnavailableReason, reply, onCancelReply, onSaved}: Props): JSX.Element {
    const {captureOwner} = useAuthRequestOwner(), comments = useFeatureAvailability('discussions'), attachments = useFeatureAvailability('discussion_attachments');
    const [draft, setDraft] = useState<DiscussionDraft>(() => drafts.get(draftKey) ?? emptyDraft());
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [uploading, setUploading] = useState<string>();
    const lock = useRef(false), latest = useRef(draft), input = useRef<HTMLInputElement>(null), textArea = useRef<TextAreaRef>(null), sendButton = useRef<HTMLElement>(null), wasBusy = useRef(false);
    latest.current = draft;
    useEffect(() => {
        if (wasBusy.current && !busy) {
            if (latest.current.pending) sendButton.current?.focus(); else textArea.current?.focus();
        }
        wasBusy.current = busy;
    }, [busy]);
    const update = (next: DiscussionDraft): void => {latest.current = next; drafts.set(draftKey, next); setDraft(next);};
    const frozen = busy || !!draft.pending;
    const addFiles = (files: File[]): void => {
        if (frozen || !canAttach || !attachments.enabled) return;
        if (draft.files.length + files.length > MAX_COMMENT_FILES) {setError('К комментарию можно прикрепить до 5 файлов.'); return;}
        const invalid = files.find(file => file.size === 0 || file.size > MAX_COMMENT_BYTES);
        if (invalid) {setError('Файл «' + invalid.name + '» должен быть непустым и не больше 10 МиБ.'); return;}
        update({...draft, files: [...draft.files, ...files.map(file => ({file, key: requestKey(), progress: 0}))]}); setError('');
    };
    const removeFile = async (key: string): Promise<void> => {
        if (frozen || lock.current) return;
        const file = latest.current.files.find(value => value.key === key), owns = captureOwner();
        if (!file || !owns()) return;
        lock.current = true;
        try {if (file.uploaded) await discussionsApi.removeUpload(file.uploaded.id); if (owns()) update({...latest.current, files: latest.current.files.filter(value => value.key !== key)});}
        catch (cause) {if (owns()) setError(errorMessage(cause, 'Не удалось убрать вложение. Повторите удаление.'));}
        finally {lock.current = false;}
    };
    const submit = async (): Promise<void> => {
        const owns = captureOwner();
        if (!owns() || lock.current || !draft.pending && (!canComment || !comments.enabled)) return;
        if (!draft.pending && !draft.body.trim()) {setError('Напишите комментарий: к нему можно прикрепить файлы.'); textArea.current?.focus(); return;}
        if (!draft.pending && new TextEncoder().encode(draft.body.trim()).length > MAX_COMMENT_BODY_BYTES) {setError('Текст слишком большой: допустимо до 16 000 байт UTF-8. Сократите его или приложите файл.'); return;}
        if (!draft.pending && draft.files.length && (!canAttach || !attachments.enabled)) {setError('Уберите вложения, чтобы отправить текст, или повторите после восстановления их доступности.'); return;}
        lock.current = true; setBusy(true); setError('');
        try {
            if (!latest.current.pending) {
                for (const file of latest.current.files) {
                    if (file.uploaded) continue;
                    setUploading(file.key);
                    try {
                        const uploaded = await discussionsApi.upload(target, file.file, file.key, progress => {
                            if (owns()) update({...latest.current, files: latest.current.files.map(value => value.key === file.key ? {...value, progress, error: undefined} : value)});
                        });
                        if (!owns()) return;
                        update({...latest.current, files: latest.current.files.map(value => value.key === file.key ? {...value, uploaded, progress: 100, error: undefined} : value)});
                    } catch (cause) {
                        if (owns()) update({...latest.current, files: latest.current.files.map(value => value.key === file.key ? {...value, error: 'Загрузка не подтверждена. Повтор использует тот же файл.'} : value)});
                        throw cause;
                    }
                }
                const value = latest.current;
                update({...value, pending: {body: value.body.trim(), parentId: reply?.id ?? value.parentId, attachmentIds: value.files.map(file => file.uploaded!.id), requestKey: requestKey()}});
            }
            const value = await discussionsApi.create(target, latest.current.pending!);
            if (!owns()) return;
            update(emptyDraft()); drafts.delete(draftKey); onCancelReply(); onSaved(value);
        } catch (cause) {
            if (owns()) {
                if (latest.current.pending && !ambiguousFailure(cause)) update({...latest.current, pending: undefined});
                setError(errorMessage(cause, 'Отправка не подтверждена. Текст и файлы сохранены; повторите тот же запрос.'));
            }
        } finally {lock.current = false; if (owns()) {setBusy(false); setUploading(undefined);}}
    };
    const replyId = draft.pending?.parentId ?? reply?.id ?? draft.parentId;
    return <section className="discussion-composer" aria-label="Новый комментарий">
        {replyId && <div className="discussion-composer__reply"><Typography.Text>Ответ {reply?.author.displayName || reply?.author.email || 'на комментарий'}</Typography.Text><Button size="small" disabled={frozen} onClick={() => {update({...draft, parentId: undefined}); onCancelReply();}}>Отменить ответ</Button></div>}
        <Input.TextArea ref={textArea} aria-label="Текст комментария" value={draft.body} disabled={frozen || !canComment || !comments.enabled} autoSize={{minRows: 3, maxRows: 10}} maxLength={8000} placeholder={canComment ? 'Вопрос, совет или отзыв… Поддерживается Markdown.' : 'Сейчас новые комментарии недоступны.'}
            onChange={event => {update({...draft, body: event.target.value, parentId: reply?.id ?? draft.parentId}); setError('');}}/>
        {draft.files.length > 0 && <ul className="discussion-composer__files">{draft.files.map(value => <li key={value.key}>
            <span>{value.file.name} <small>{fileSize(value.file.size)}</small></span>
            <Button size="small" type="text" aria-label={'Убрать файл ' + value.file.name} disabled={frozen} onClick={() => {void removeFile(value.key);}}>Убрать</Button>
            {uploading === value.key && <Progress percent={value.progress} size="small"/>}
            {value.error && <Typography.Text type="danger">{value.error}</Typography.Text>}
        </li>)}</ul>}
        {error && <Alert role="alert" showIcon type="error" message={error}/>}
        {draft.pending && <Alert showIcon type="warning" message="Подтверждение отправки не получено" description="Повторите этот запрос: текст, адресат и файлы зафиксированы, второй комментарий не создаётся."/>}
        {!comments.enabled && <Typography.Paragraph type="secondary">{comments.reason}</Typography.Paragraph>}
        <div className="discussion-composer__actions"><Space wrap>
            <input ref={input} type="file" multiple hidden aria-label="Файлы комментария" onChange={event => {addFiles(Array.from(event.target.files ?? [])); event.target.value = '';}}/>
            <Tooltip title={!canAttach ? attachmentsUnavailableReason || 'Вложения временно недоступны. Можно отправить текст.' : !attachments.enabled ? attachments.reason : 'До 5 файлов, каждый до 10 МиБ'}>
                <span><Button icon={<PaperClipOutlined aria-hidden/>} disabled={frozen || !canComment || !canAttach || !attachments.enabled || !comments.enabled} onClick={() => input.current?.click()}>Файлы</Button></span>
            </Tooltip>
            {(!canAttach || !attachments.enabled) && <Typography.Text type="secondary">{attachmentsUnavailableReason || 'Вложения сейчас недоступны. Текст можно отправить.'}</Typography.Text>}
        </Space><Button ref={sendButton} type="primary" icon={<SendOutlined aria-hidden/>} loading={busy} disabled={busy || !draft.pending && (!canComment || !comments.enabled)} onClick={() => {void submit();}}>{draft.pending ? 'Повторить отправку' : 'Отправить'}</Button></div>
    </section>;
}
