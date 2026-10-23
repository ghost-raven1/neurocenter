import {Alert, Button, Empty, Input, List, Space, Spin, Typography} from 'antd';
import {ArrowLeftOutlined, DownloadOutlined, EditOutlined, FileMarkdownOutlined, PlusOutlined, ReloadOutlined} from '@ant-design/icons';
import {useEffect, useRef, useState} from 'react';
import {Link, useHistory, useParams} from 'react-router-dom';
import {useAuthRequestOwner} from '../../features/UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../../features/FeatureFlags/FeatureAvailability';
import {DiscussionThread, SafeMarkdown} from '../../features/Discussions';
import {errorMessage} from '../../common/utils/errorMessage';
import {helpApi} from './api';
import {downloadMarkdown, filterArticles} from './model';
import {HelpEditor} from './HelpEditor';
import type {HelpArticle, HelpOverview} from './types';
import './Help.less';

function HelpContent(): JSX.Element {
    const {slug} = useParams<{slug?: string}>(), history = useHistory(), {captureOwner} = useAuthRequestOwner(), availability = useFeatureAvailability('help_center');
    const [overview, setOverview] = useState<HelpOverview>(), [article, setArticle] = useState<HelpArticle>(), [query, setQuery] = useState('');
    const [loading, setLoading] = useState(false), [error, setError] = useState(''), [editor, setEditor] = useState<{key: string; article?: HelpArticle}>(), [editorOpen, setEditorOpen] = useState(false);
    const sequence = useRef(0);
    const load = async (): Promise<void> => {
        const owns = captureOwner(), read = ++sequence.current; if (!owns()) return;
        setLoading(true); setError('');
        try {
            const value = slug ? await helpApi.get(slug) : await helpApi.list();
            if (owns() && sequence.current === read) {if ('content' in value) setArticle(value); else setOverview(value);}
        } catch (cause) {if (owns() && sequence.current === read) {setArticle(undefined); setError(errorMessage(cause, 'Не удалось открыть помощь. Повторите загрузку.'));}}
        finally {if (owns() && sequence.current === read) setLoading(false);}
    };
    useEffect(() => {setArticle(undefined); void load(); return () => {sequence.current++;};}, [slug, captureOwner]);
    const edit = (value?: HelpArticle): void => {
        const key = value?.slug ?? 'new';
        if (editor?.key !== key) setEditor({key, article: value});
        setEditorOpen(true);
    };
    const saved = (value: HelpArticle): void => {
        sequence.current++; setArticle(value); setEditorOpen(false); setEditor(undefined); setError('');
        if (slug !== value.slug) history.push('/help/' + encodeURIComponent(value.slug));
        else void load();
    };
    const items = filterArticles(overview?.items ?? [], query);
    return <main className="help-page">
        <header className="help-page__heading"><div>{slug && <Link to="/help"><ArrowLeftOutlined aria-hidden/> Все статьи</Link>}<Typography.Title level={2}>{slug ? article?.title || 'Статья' : 'Помощь'}</Typography.Title>{!slug && <Typography.Paragraph type="secondary">Ответы, инструкции и обсуждения в одном месте.</Typography.Paragraph>}</div>
            <Space wrap><Button aria-label="Обновить статьи помощи" icon={<ReloadOutlined/>} loading={loading} onClick={() => {void load();}}>Обновить</Button>
                {slug && article && <><Button icon={<DownloadOutlined aria-hidden/>} onClick={() => downloadMarkdown(article.slug, article.content)}>Скачать .md</Button>{article.canEdit && <Button icon={<EditOutlined aria-hidden/>} disabled={!availability.enabled} onClick={() => edit(article)}>Редактировать</Button>}</>}
                {!slug && overview?.canEdit && <Button type="primary" icon={<PlusOutlined aria-hidden/>} disabled={!availability.enabled} onClick={() => edit()}>Добавить статью</Button>}
            </Space>
        </header>
        {error && <Alert role="alert" type="error" showIcon message={error} action={<Button onClick={() => {void load();}}>Повторить</Button>}/>}
        {!availability.enabled && <Alert showIcon type="info" message={availability.reason} description="Опубликованные статьи и история обсуждений доступны для чтения."/>}
        {loading && !article && !overview && <Spin tip="Открываем помощь…"/>}
        {!slug && overview && <>
            <Input.Search className="help-page__search" aria-label="Поиск по статьям помощи" placeholder="Найти ответ…" value={query} allowClear onChange={event => setQuery(event.target.value)}/>
            <List className="help-page__articles" dataSource={items} locale={{emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query ? 'Статьи не найдены. Попробуйте другой запрос.' : 'Пока нет статей. Администратор может добавить файл .md.'}/>}} renderItem={value => <List.Item>
                <List.Item.Meta avatar={<FileMarkdownOutlined/>} title={<Link to={'/help/' + encodeURIComponent(value.slug)}>{value.title}</Link>} description={value.summary}/>
            </List.Item>}/>
            {overview.canEdit && <Typography.Paragraph type="secondary">Добавляйте статьи через Markdown-редактор или правьте их .md-файлы в настроенной папке помощи — пересборка интерфейса не нужна.</Typography.Paragraph>}
        </>}
        {slug && article?.slug === slug && <><article className="help-page__article"><SafeMarkdown body={article.content}/></article><DiscussionThread target={{type: 'help', id: article.slug}}/></>}
        {editor && <HelpEditor key={editor.key} open={editorOpen} article={editor.article} onClose={() => setEditorOpen(false)} onSaved={saved}/>}
    </main>;
}

/** A session change discards the previous actor's read data and private editor. */
export default function Help(): JSX.Element {
    const {scope} = useAuthRequestOwner(); return <HelpContent key={scope}/>;
}
