import {Alert, Button, Input, Modal, Space, Tabs, Typography} from 'antd';
import {DownloadOutlined, UploadOutlined} from '@ant-design/icons';
import {useRef, useState} from 'react';
import {isAxiosError} from 'axios';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../../features/UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../../features/FeatureFlags/FeatureAvailability';
import {SafeMarkdown} from '../../features/Discussions/SafeMarkdown';
import {helpApi} from './api';
import {downloadMarkdown, MAX_HELP_BYTES, validHelpSlug} from './model';
import type {HelpArticle} from './types';

interface Props {article?: HelpArticle; open: boolean; onClose: () => void; onSaved: (value: HelpArticle) => void}

/** The editor retains its source until a confirmed save; a stale SHA requires explicit review. */
export function HelpEditor({article, open, onClose, onSaved}: Props): JSX.Element {
    const {captureOwner} = useAuthRequestOwner(), availability = useFeatureAvailability('help_center');
    const [content, setContent] = useState(article?.content ?? '# Новая статья\n\n'), [slug, setSlug] = useState(article?.slug ?? '');
    const [revision, setRevision] = useState<string | null>(article?.revision ?? null), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [review, setReview] = useState(false), [latest, setLatest] = useState<HelpArticle>(), [missing, setMissing] = useState(false);
    const lock = useRef(false), fileInput = useRef<HTMLInputElement>(null);
    const check = async (): Promise<void> => {
        const owns = captureOwner(); if (!owns() || lock.current) return;
        lock.current = true; setBusy(true); setError(''); setMissing(false); setLatest(undefined);
        try {const value = await helpApi.get(slug); if (owns()) {setLatest(value); if (value.content === content) onSaved(value);}}
        catch (cause) {if (owns()) {
            if (!article && isAxiosError(cause) && cause.response?.status === 404) setMissing(true);
            else setError(errorMessage(cause, 'Не удалось проверить статью. Исходник сохранён в редакторе.'));
        }}
        finally {lock.current = false; if (owns()) setBusy(false);}
    };
    const save = async (): Promise<void> => {
        const owns = captureOwner(); if (!owns() || lock.current || review || !availability.enabled) return;
        if (!validHelpSlug(slug)) {setError('Адрес статьи: латинские строчные буквы, цифры и дефис, до 80 символов.'); return;}
        if (!content.trim() || new TextEncoder().encode(content).length > MAX_HELP_BYTES) {setError('Статья должна быть непустой и не больше 512 КиБ.'); return;}
        if (content.includes('\0') || !/^#[ \t]+\S/m.test(content.replace(/^\uFEFF/, ''))) {setError('Добавьте заголовок статьи в строке «# Заголовок». Нулевые символы в тексте недопустимы.'); return;}
        lock.current = true; setBusy(true); setError('');
        try {const value = await helpApi.save(slug, content, revision); if (owns()) {setRevision(value.revision); onSaved(value);}}
        catch (cause) {if (owns()) {
            const status = isAxiosError(cause) ? cause.response?.status : undefined;
            setReview(status === undefined || status >= 500 || status === 408 || status === 409); setLatest(undefined); setMissing(false);
            setError(errorMessage(cause, 'Сохранение не подтверждено. Сверьте актуальную статью; исходник остался в редакторе.'));
        }}
        finally {lock.current = false; if (owns()) setBusy(false);}
    };
    const importFile = async (file?: File): Promise<void> => {
        const owns = captureOwner(); if (!file || !owns() || busy) return;
        if (!/\.md$/i.test(file.name) || file.size > MAX_HELP_BYTES || !file.size) {setError('Выберите непустой файл .md размером до 512 КиБ.'); return;}
        try {
            const value = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(await file.arrayBuffer()); if (!owns()) return;
            setContent(value); if (!article && !slug) setSlug(file.name.replace(/\.md$/i, '')); setError('');
        } catch (cause) {if (owns()) setError(errorMessage(cause, 'Не удалось прочитать Markdown. Текущий текст сохранён.'));}
    };
    return <Modal open={open} title={article ? 'Редактирование статьи' : 'Новая статья'} width={980} footer={null} onCancel={() => {if (!busy) onClose();}} maskClosable={false} closable={!busy} keyboard={!busy} bodyStyle={{maxHeight: 'calc(100dvh - 180px)', overflowY: 'auto'}}>
        <div className="help-editor">
            <label htmlFor="help-article-slug">Адрес статьи</label><Input id="help-article-slug" value={slug} disabled={!!article || busy || review} placeholder="getting-started" addonBefore="/help/" onChange={event => setSlug(event.target.value)}/>
            <Typography.Paragraph type="secondary">Исходник — файл .md. Заголовок статьи берётся из первой строки «# Заголовок». Изменения файла отображаются после открытия или обновления статьи.</Typography.Paragraph>
            <Space wrap><input hidden ref={fileInput} type="file" accept=".md,text/markdown" aria-label="Импорт Markdown" onChange={event => {void importFile(event.target.files?.[0]); event.target.value = '';}}/>
                <Button icon={<UploadOutlined aria-hidden/>} disabled={busy} onClick={() => fileInput.current?.click()}>Открыть .md</Button><Button icon={<DownloadOutlined aria-hidden/>} onClick={() => downloadMarkdown(validHelpSlug(slug) ? slug : 'article', content)}>Скачать .md</Button>
            </Space>
            <Tabs defaultActiveKey="source" items={[
                {key: 'source', label: 'Markdown', children: <Input.TextArea className="help-editor__source" aria-label="Markdown статьи" value={content} disabled={busy} autoSize={{minRows: 14, maxRows: 28}} onChange={event => setContent(event.target.value)}/>},
                {key: 'preview', label: 'Предпросмотр', children: <article className="help-editor__preview"><SafeMarkdown body={content}/></article>},
            ]}/>
            {error && <Alert role="alert" type="error" showIcon message={error}/>}
            {review && <Alert showIcon type="warning" message="Проверьте статью перед повторным сохранением" description={<Space direction="vertical">
                <Button loading={busy} disabled={!validHelpSlug(slug)} onClick={() => {void check();}}>Прочитать актуальную статью</Button>
                {missing && <><Typography.Text>Статья с этим адресом пока не создана.</Typography.Text><Button disabled={busy} onClick={() => {setRevision(null); setReview(false); setError('');}}>Вернуться к созданию, сохранив мой текст</Button></>}
                {latest && <>
                    {latest.content === content ? <Typography.Text>Этот исходник уже сохранён.</Typography.Text> : <details><summary>Актуальный Markdown</summary><pre className="help-editor__comparison">{latest.content}</pre></details>}
                    <Button disabled={busy || !latest.canEdit} onClick={() => {setRevision(latest.revision); setReview(false); setError('');}}>Использовать эту версию, сохранив мой текст</Button>
                </>}
            </Space>}/>}
            {!availability.enabled && <Alert type="info" showIcon message={availability.reason}/>}
            <div className="help-editor__footer"><Typography.Text type="secondary">Текст сохраняется при закрытии редактора.</Typography.Text><Space wrap><Button disabled={busy} onClick={onClose}>Закрыть</Button><Button type="primary" loading={busy} disabled={busy || review || !availability.enabled} onClick={() => {void save();}}>Сохранить статью</Button></Space></div>
        </div>
    </Modal>;
}
