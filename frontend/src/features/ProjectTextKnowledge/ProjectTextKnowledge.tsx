import {Alert, Button, Input, Space, Tag, Typography} from 'antd';
import {FileTextOutlined, PlusOutlined, SearchOutlined} from '@ant-design/icons';
import {useRef} from 'react';
import {textBytes} from '@neurocenter/project-text-knowledge';
import type {TextContext} from './model';
import {formatKnowledgeBytes, type TextKnowledgeLimits} from './limits';
import {useProjectTextKnowledge} from './useProjectTextKnowledge';
import './ProjectTextKnowledge.less';

interface Props {projectId:string; limits?:Readonly<TextKnowledgeLimits>; onSelectContext?:(context:TextContext) => void;}

/** Basic project knowledge needs only text storage and word search; advanced indexing is optional. */
export function ProjectTextKnowledge({projectId, limits, onSelectContext}:Props):JSX.Element {
    const value = useProjectTextKnowledge(projectId, limits), input = useRef<HTMLInputElement>(null);
    const pending = !!value.intent && !value.receipt;
    const busy = value.uploading || value.recovering || value.selecting;
    const mayUpload = value.availability.enabled && value.canWrite && !!value.corpus && !value.journalError
        && (!!value.limits && !value.limitsError || pending);
    const result = value.result;
    return <section className="project-text-knowledge" aria-label="Текстовая база знаний">
        <div className="project-text-knowledge__heading">
            <div><Typography.Title level={4}>База знаний проекта</Typography.Title>
                <Typography.Paragraph type="secondary">Добавьте документы или код и найдите нужный фрагмент по словам.</Typography.Paragraph></div>
            <Tag>Текстовый поиск</Tag>
        </div>
        <div className="project-text-knowledge__status" role="status">
            {value.corpus ? <span>Файлов: {value.corpus.documentCount} · {formatKnowledgeBytes(value.corpus.bytes)} · Версия {value.corpus.revision}</span>
                : <span>{value.reading ? 'Читаем базу знаний…' : 'Сведения о базе знаний не получены'}</span>}
            <Button type="link" size="small" loading={value.reading} onClick={() => {void value.refresh();}}>Обновить сведения</Button>
        </div>
        {!value.availability.enabled && <Alert type="info" showIcon message={value.availability.reason} />}
        {value.readError && <Alert type="warning" showIcon message="Не удалось обновить базу знаний" description={value.readError}
            action={<Button size="small" onClick={() => {void value.refresh();}}>Повторить</Button>} />}
        {value.journalError && <Alert type="warning" showIcon message="Нужна проверка журнала загрузки" description={value.journalError} />}
        {value.limitsError && <Alert type="warning" showIcon message="Лимиты базы знаний не подтверждены" description={value.limitsError}
            action={<Button size="small" loading={value.loadingLimits} onClick={() => {void value.refreshLimits();}}>Проверить лимиты</Button>} />}
        <div className="project-text-knowledge__upload">
            <input ref={input} type="file" multiple aria-label="Выбрать текстовые файлы" hidden onChange={event => {
                const files = Array.from(event.target.files ?? []); event.target.value = '';
                if (files.length) void value.selectFiles(files);
            }} />
            <Space wrap>
                <Button type={value.documents.length ? 'default' : 'primary'} icon={<PlusOutlined aria-hidden="true" />} loading={value.selecting}
                    disabled={!mayUpload || busy} onClick={() => input.current?.click()}>Добавить файлы</Button>
                {!!value.documents.length && <Button type="primary" loading={value.uploading} disabled={!mayUpload || busy}
                    onClick={() => {void value.upload();}}>{pending ? 'Повторить эту загрузку' : 'Сохранить в базе знаний'}</Button>}
            </Space>
            {!value.canWrite && <Typography.Text type="secondary">Добавлять файлы могут разработчики и администраторы проекта.</Typography.Text>}
            {value.limits && <Typography.Text type="secondary">UTF-8 · до {value.limits.limits.documents} файлов · {formatKnowledgeBytes(value.limits.limits.fileBytes)} на файл · {formatKnowledgeBytes(value.limits.limits.batchBytes)} за загрузку</Typography.Text>}
            {!!value.documents.length && <ul className="project-text-knowledge__files" aria-label="Файлы для загрузки">{value.documents.map(document => <li key={document.path}>
                <FileTextOutlined aria-hidden="true" /><span>{document.path}</span><Typography.Text type="secondary">{formatKnowledgeBytes(textBytes(document.content))}</Typography.Text>
                <Button size="small" type="text" disabled={busy} aria-label={`Убрать ${document.path}`} onClick={() => value.removeFile(document.path)}>Убрать</Button>
            </li>)}</ul>}
        </div>
        {value.uploadError && <Alert type="warning" showIcon message="Загрузка не завершена" description={value.uploadError} />}
        {value.intent && <div className="project-text-knowledge__receipt">
            <span>{value.receipt ? `Загрузка принята: версия ${value.receipt.revision}.` : value.recoveryMessage || 'Проверяем прежнюю загрузку…'}</span>
            {value.receipt && value.corpus && value.receipt.revision < value.corpus.revision && <Typography.Text type="secondary">Сейчас в базе более новая версия: {value.corpus.revision}.</Typography.Text>}
            {!value.receipt && <Space wrap><Button size="small" loading={value.recovering} disabled={value.uploading} onClick={() => {void value.recover();}}>Проверить загрузку</Button>
                {value.canRebase && <Button size="small" disabled={!mayUpload || busy} onClick={value.rebase}>Использовать актуальную версию</Button>}</Space>}
            <details><summary>Квитанция загрузки</summary><code>{value.intent.requestKey}</code>
                {value.receipt?.admission && <div>Правила загрузки: версия {value.receipt.admission.revision}</div>}</details>
        </div>}
        <form className="project-text-knowledge__search" onSubmit={event => {event.preventDefault(); void value.search();}}>
            <label htmlFor={`knowledge-query-${projectId}`}>Поиск по базе знаний</label>
            <div className="project-text-knowledge__query"><Input id={`knowledge-query-${projectId}`} value={value.query}
                placeholder="Например: авторизация пользователя" onChange={event => value.setQuery(event.target.value)} />
                <Button type="primary" htmlType="submit" icon={<SearchOutlined aria-hidden="true" />} loading={value.searching}
                    disabled={!value.availability.enabled || !value.corpus || !value.query.trim() || !value.limits || !!value.limitsError}>Найти</Button></div>
            {!value.corpus?.documentCount && value.corpus && <Typography.Text type="secondary">База пока пуста. Добавьте первый текстовый файл.</Typography.Text>}
            {value.limits && <Typography.Text type="secondary">До {value.limits.limits.queryBytes} байт в запросе · до {value.limits.limits.sources} источников</Typography.Text>}
        </form>
        {value.searchError && <Alert type="warning" showIcon message="Поиск не завершён" description={value.searchError} />}
        {result && <div className="project-text-knowledge__results" aria-live="polite">
            <div className="project-text-knowledge__result-heading"><Typography.Text strong>{result.sources.length ? `Найдено источников: ${result.sources.length}` : 'Совпадений нет'}</Typography.Text>
                {!!result.sources.length && onSelectContext && <Button size="small" disabled={!value.availability.enabled}
                    onClick={() => onSelectContext({mode:'text', revision:result.revision, corpusHash:result.corpusHash, query:value.query})}>Использовать как контекст</Button>}</div>
            {!result.sources.length && <Typography.Paragraph type="secondary">Попробуйте другие слова или добавьте нужные документы.</Typography.Paragraph>}
            {result.sources.map(source => <article className="project-text-knowledge__source" key={source.id}>
                <Typography.Text strong>{source.path}</Typography.Text><Typography.Text type="secondary">Строки {source.startLine}–{source.endLine}</Typography.Text>
                <pre>{source.excerpt}</pre>
            </article>)}
        </div>}
    </section>;
}
