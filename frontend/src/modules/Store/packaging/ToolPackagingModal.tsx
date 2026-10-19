import { Alert, Button, Collapse, Form, Input, Modal, Progress, Radio, Select, Space, Typography } from 'antd';
import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../../common/utils/errorMessage';
import { packagingEntrypoints, readPackagingFiles } from './sourceFiles';
import { readPackagingArchive } from './sourceArchive';
import { SourceFilesPicker } from './SourceFilesPicker';
import { useNpmMetadata } from './useNpmMetadata';
import { useRepositoryMetadata } from './useRepositoryMetadata';
import { useToolBuild } from './useToolBuild';
import { defaultPackagingTitle, packagingTitle } from './packagingTitle';
import { packagingKind } from './packagingKind';
import { repositoryBuildSource, repositoryName } from './repositorySource';
import { RepositoryMetadataDetails } from './RepositoryMetadataDetails';
import { NpmMetadataDetails } from './NpmMetadataDetails';
import type { PackagingFilesResult } from './sourceFiles';
import type { PackagingKind } from './types';
import './ToolPackaging.less';

interface Props { open: boolean; scope: string; onClose: () => void; onPublished: (id: string) => Promise<void> }
const { Text, Paragraph } = Typography;

/** Упаковка и публикация выполняются одной серверной операцией, с возобновляемым прогрессом. */
export const ToolPackagingModal: FC<Props> = ({ open, scope, onClose, onPublished }) => {
    const [source, setSource] = useState<'npm' | 'files' | 'repository'>('npm');
    const [specifier, setSpecifier] = useState('');
    const [repositoryUrl, setRepositoryUrl] = useState('');
    const [repositoryRef, setRepositoryRef] = useState('');
    const [subdirectory, setSubdirectory] = useState('');
    const [repositoryEntrypoint, setRepositoryEntrypoint] = useState('');
    const [repositoryEntry, setRepositoryEntry] = useState<{ revision: string; value: string }>();
    const [kind, setKind] = useState<PackagingKind>('mcp');
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [uploaded, setUploaded] = useState<PackagingFilesResult>();
    const [archiveName, setArchiveName] = useState('');
    const [entrypoint, setEntrypoint] = useState('');
    const [reading, setReading] = useState(false);
    const [preparing, setPreparing] = useState(false);
    const [opening, setOpening] = useState(false);
    const [error, setError] = useState('');
    const archiveRequest = useRef<AbortController>();
    const alive = useRef(true);
    const readRequest = useRef(0);
    const manualEntrypoint = useRef(false);
    const explicitKind = useRef<{ source: string; package?: string }>();
    const npm = useNpmMetadata(specifier);
    const repository = useRepositoryMetadata({ url: repositoryUrl, ref: repositoryRef, subdirectory, entrypoint: repositoryEntrypoint });
    const build = useToolBuild(scope);
    const busy = build.submitting || build.active || preparing || reading;
    const candidates = useMemo(() => packagingEntrypoints(uploaded?.files ?? [], kind), [uploaded, kind]);
    const metadata = source === 'npm' ? npm.metadata : source === 'repository' ? repository.metadata : undefined;
    const sourceKey = source === 'npm' ? `npm:${specifier.trim()}` : source === 'repository' ? `repository:${JSON.stringify([repositoryUrl.trim(), repositoryRef.trim(), subdirectory.trim(), repositoryEntrypoint.trim()])}` : 'files';
    const metadataIdentity = source === 'npm' && npm.metadata ? `npm:${npm.metadata.package}` : source === 'repository' && repository.metadata ? `repository:${repository.metadata.url}:${repository.metadata.subdirectory ?? ''}` : undefined;
    const repositoryRevision = repository.metadata ? `${repository.metadata.url}:${repository.metadata.commit}:${repository.metadata.subdirectory ?? ''}` : '';
    const repositoryRuntime = source === 'repository' && !!repository.metadata?.adapter;
    const selectedRepositoryEntry = repositoryEntry?.revision === repositoryRevision ? repositoryEntry.value : repository.metadata?.entrypoint || '';
    const suggestedName = source === 'npm' ? defaultPackagingTitle(npm.metadata?.package ?? specifier.trim()) : source === 'repository' ? defaultPackagingTitle(repository.metadata?.name || repositoryName(repositoryUrl)) : uploaded?.rootName || archiveName.replace(/\.(?:zip|tar|tar\.gz|tgz)$/i, '') || 'Мой инструмент';

    useEffect(() => { alive.current = true; return () => { alive.current = false; readRequest.current++; archiveRequest.current?.abort(); }; }, []);
    useEffect(() => {
        if (!manualEntrypoint.current || !candidates.includes(entrypoint)) {
            manualEntrypoint.current = false;
            setEntrypoint(candidates[0] ?? '');
        }
    }, [candidates, entrypoint]);
    useEffect(() => {
        if (!metadata) return;
        const explicit = explicitKind.current?.source === sourceKey || !!metadataIdentity && explicitKind.current?.package === metadataIdentity;
        setKind(current => packagingKind(current, metadata, explicit));
    }, [sourceKey, metadata, metadataIdentity]);

    const readFiles = async (input: readonly File[], fromArchive = false): Promise<void> => {
        if (!input?.length || busy) return;
        const selected = Array.from(input);
        const request = ++readRequest.current;
        archiveRequest.current?.abort();
        const controller = new AbortController();
        archiveRequest.current = controller;
        manualEntrypoint.current = false;
        setReading(true); setError(''); setUploaded(undefined); setEntrypoint(''); setArchiveName('');
        try {
            if (fromArchive && selected.length !== 1) throw new Error('Добавьте один архив за раз.');
            const next = fromArchive ? await readPackagingArchive(selected[0], controller.signal) : await readPackagingFiles(selected);
            if (alive.current && request === readRequest.current) { setUploaded(next); setArchiveName(fromArchive ? selected[0].name : ''); }
        } catch (cause) { if (alive.current && request === readRequest.current) setError(errorMessage(cause, 'Не удалось прочитать исходники.')); }
        finally { if (alive.current && request === readRequest.current) setReading(false); }
    };
    const submit = async (): Promise<void> => {
        if (busy) return;
        setPreparing(true); setError('');
        try {
            // Ошибка предпроверки уже показана у источника и принадлежит его текущему значению.
            const npmMetadata = source === 'npm' ? await npm.resolve().catch(() => undefined) : undefined;
            const repositoryMetadata = source === 'repository' ? await repository.resolve().catch(() => undefined) : undefined;
            if (source === 'npm' && !npmMetadata || source === 'repository' && !repositoryMetadata) return;
            if (!alive.current) return;
            const resolved = npmMetadata || repositoryMetadata;
            const title = packagingTitle(name, npmMetadata?.package || repositoryMetadata?.name || suggestedName);
            const summary = description.trim() || resolved?.description?.trim() || `Инструмент ${title} для OpenCode.`;
            if (summary.length > 2000) throw new Error('Описание — до 2000 символов.');
            if (source === 'files' && (!uploaded?.files.length || !entrypoint)) throw new Error('Выберите исходники и файл запуска.');
            const identity = npmMetadata ? `npm:${npmMetadata.package}` : repositoryMetadata ? `repository:${repositoryMetadata.url}:${repositoryMetadata.subdirectory ?? ''}` : undefined;
            const explicit = explicitKind.current?.source === sourceKey || !!identity && explicitKind.current?.package === identity;
            // POST принадлежит хуку; поздний ответ не удерживает подготовку следующей формы.
            void build.submit({ name: title, description: summary, kind: packagingKind(kind, resolved, explicit),
                source: npmMetadata ? { type: 'npm', specifier: npmMetadata.specifier } : repositoryMetadata ? repositoryBuildSource(repositoryMetadata, repositoryEntry?.revision === `${repositoryMetadata.url}:${repositoryMetadata.commit}:${repositoryMetadata.subdirectory ?? ''}` ? repositoryEntry.value : repositoryMetadata.entrypoint) : { type: 'files', files: uploaded!.files, entrypoint } });
        } catch (cause) { if (alive.current) setError(errorMessage(cause, 'Не удалось начать упаковку.')); }
        finally { if (alive.current) setPreparing(false); }
    };
    const openPublished = async (): Promise<void> => {
        if (!build.job?.result || opening) return;
        setOpening(true); setError('');
        try { await onPublished(build.job.result.catalogId); }
        catch (cause) { if (alive.current) setError(errorMessage(cause, 'Инструмент опубликован. Не удалось открыть карточку — обновите каталог.')); }
        finally { if (alive.current) setOpening(false); }
    };

    return <Modal open={open} title="Упаковать инструмент" width={680} footer={null} onCancel={onClose} className="tool-packaging" style={{ top: 32 }}>
        <Paragraph type="secondary">Добавьте npm-пакет, репозиторий GitHub, папку или архив исходников. Система соберёт автономный комплект и добавит его в каталог для установки через мост.</Paragraph>
        {build.unresolved && <Alert className="tool-packaging__error" type="warning" showIcon message="Результат первого запроса ещё неизвестен"
            description={<>
                <div>Сервер мог принять исходный запрос. Сохраняем его ключ: повторная отправка не создаст вторую сборку. После перезагрузки при необходимости выберите исходники заново.</div>
                <Button className="tool-packaging__recheck" onClick={build.recheck}>Проверить сохранённый запрос</Button>
            </>} />}
        {build.job || build.active ? <div className="tool-packaging__progress" role="status" aria-live="polite">
            <Text strong>{build.job?.result?.name ?? build.job?.name ?? (name || suggestedName || 'Сборка инструмента')}</Text>
            <Progress percent={Math.max(0, Math.min(100, build.job?.percent ?? 0))} aria-label="Прогресс упаковки" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, build.job?.percent ?? 0))} status={build.job?.state === 'FAILED' ? 'exception' : build.job?.state === 'SUCCEEDED' ? 'success' : 'active'} />
            <Paragraph>{build.job?.message ?? 'Загружаем состояние сборки…'}</Paragraph>
            {build.job?.state === 'FAILED' && <Alert type="error" showIcon message={build.job.error || 'Сборка не завершена. Исходники сохранены, можно повторить.'} />}
            <Space wrap className="tool-packaging__actions">
                <Button onClick={onClose}>Скрыть</Button>
                {build.job?.state === 'SUCCEEDED' && <Button type="primary" loading={opening} onClick={() => { void openPublished(); }}>Открыть в каталоге</Button>}
                {build.job && !build.active && <Button onClick={build.reset}>{build.job.state === 'FAILED' ? 'Вернуться к исходникам' : 'Упаковать ещё'}</Button>}
            </Space>
        </div> : <Form layout="vertical" onFinish={() => { void submit(); }} disabled={busy}>
            <Form.Item label="Источник"><Radio.Group aria-label="Источник инструмента" value={source} onChange={event => { setSource(event.target.value); setError(''); }} options={[{ label: 'npm-пакет', value: 'npm' }, { label: 'Репозиторий GitHub', value: 'repository' }, { label: 'Файлы или архив', value: 'files' }]} optionType="button" className="tool-packaging__sources" /></Form.Item>
            {source === 'npm' ? <>
                <Form.Item label="Пакет или ссылка npm" extra="Версия закрепится перед сборкой. Можно указать package@version.">
                    <Input.Search aria-label="npm-пакет или ссылка" value={specifier} onChange={event => setSpecifier(event.target.value)} placeholder="Например, opencode-snip" loading={npm.loading} enterButton="Проверить"
                        onPressEnter={event => event.preventDefault()} onBlur={() => { if (specifier.trim()) void npm.resolve().catch(() => {}); }} onSearch={() => { void npm.resolve().catch(() => {}); }} />
                </Form.Item>
                {npm.metadata && <NpmMetadataDetails metadata={npm.metadata} />}
                {npm.error && <Alert type="error" showIcon message={npm.error} />}
            </> : source === 'repository' ? <>
                <Form.Item label="Ссылка на репозиторий" extra="Публичный GitHub по HTTPS. Без входа, токенов и SSH.">
                    <Input.Search aria-label="Ссылка на репозиторий GitHub" value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repository" loading={repository.loading} enterButton="Проверить"
                        onPressEnter={event => event.preventDefault()} onBlur={() => { if (repositoryUrl.trim()) void repository.resolve().catch(() => {}); }} onSearch={() => { void repository.resolve().catch(() => {}); }} />
                </Form.Item>
                <Paragraph type="secondary">JS и TypeScript — из исходников. Python, Java, .NET, Go, Rust и native — из готовых поставок по рецепту neurocenter.tool.json.</Paragraph>
                <Collapse ghost className="tool-packaging__details"><Collapse.Panel header="Ветка и подпапка" key="repository">
                    <Form.Item label="Ветка, тег или commit" extra="По умолчанию — основная ветка репозитория."><Input aria-label="Ветка, тег или commit" value={repositoryRef} onChange={event => setRepositoryRef(event.target.value)} placeholder="Например, main или v1.0.0" /></Form.Item>
                    <Form.Item label="Подпапка" extra="Для инструмента внутри monorepo."><Input aria-label="Подпапка репозитория" value={subdirectory} onChange={event => setSubdirectory(event.target.value)} placeholder="Например, packages/my-tool" /></Form.Item>
                    <Form.Item label={repositoryRuntime ? 'Рецепт поставки' : 'Файл запуска или рецепт'} extra="По умолчанию определяется автоматически."><Input aria-label={repositoryRuntime ? 'Рецепт поставки репозитория вручную' : 'Файл запуска репозитория вручную'} value={repositoryEntrypoint} onChange={event => { setRepositoryEntrypoint(event.target.value); setRepositoryEntry(undefined); }} placeholder={repositoryRuntime ? 'neurocenter.tool.json' : 'src/server.ts'} /></Form.Item>
                </Collapse.Panel></Collapse>
                {repository.metadata && <RepositoryMetadataDetails metadata={repository.metadata} entrypoint={selectedRepositoryEntry} />}
                {repository.metadata && !repositoryRuntime && repository.metadata.candidates.length > 1 && <Form.Item label="Файл запуска"><Select aria-label="Файл запуска репозитория" value={selectedRepositoryEntry || undefined} onChange={value => setRepositoryEntry({ revision: repositoryRevision, value })} options={repository.metadata.candidates.map(value => ({ value, label: value }))} placeholder="Выберите файл запуска" /></Form.Item>}
                {repository.error && <Alert type="error" showIcon message={repository.error} />}
            </> : <>
                <Form.Item label="Исходники JS / TypeScript"><SourceFilesPicker disabled={busy} reading={reading} uploaded={uploaded} archiveName={archiveName} onSelect={(input, fromArchive) => { void readFiles(input, fromArchive); }} /></Form.Item>
                <Paragraph type="secondary" className="tool-packaging__language-note">Python, Java, .NET, Go, Rust и native добавляются через репозиторий с рецептом поставки.</Paragraph>
                {uploaded && <Form.Item label="Файл запуска"><Select aria-label="Файл запуска" value={entrypoint || undefined} onChange={value => { manualEntrypoint.current = true; setEntrypoint(value); }} showSearch options={candidates.map(value => ({ value, label: value }))} placeholder="В исходниках нужен JS или TS entrypoint" /></Form.Item>}
                {uploaded && !candidates.length && <Alert type="warning" showIcon message="В исходниках нет файла запуска JS или TypeScript" description="Выберите архив с исходниками инструмента. Для других языков используйте репозиторий с neurocenter.tool.json." />}
            </>}
            <Form.Item label="Тип инструмента"><Radio.Group aria-label="Тип инструмента" value={repositoryRuntime ? 'mcp' : kind} onChange={event => { explicitKind.current = { source: sourceKey, package: metadataIdentity }; setKind(event.target.value); }} options={[{ label: 'MCP', value: 'mcp' }, { label: 'Плагин OpenCode', value: 'plugin', disabled: repositoryRuntime }]} /></Form.Item>
            <Collapse ghost className="tool-packaging__details"><Collapse.Panel header="Название и описание" key="details">
                <Form.Item label="Название в каталоге"><Input aria-label="Название в каталоге" value={name} maxLength={128} onChange={event => setName(event.target.value)} placeholder={suggestedName || 'Название из пакета'} /></Form.Item>
                <Form.Item label="Описание"><Input.TextArea aria-label="Описание инструмента" rows={2} value={description} maxLength={2000} onChange={event => setDescription(event.target.value)} placeholder={metadata?.description || 'Кратко опишите инструмент'} /></Form.Item>
            </Collapse.Panel></Collapse>
            <Space wrap className="tool-packaging__actions"><Button onClick={onClose}>Закрыть</Button><Button type="primary" htmlType="submit" loading={preparing || build.submitting} disabled={busy || (source === 'npm' ? !specifier.trim() : source === 'repository' ? !repositoryUrl.trim() : !uploaded?.files.length || !entrypoint)}>{build.unresolved ? 'Повторить запрос' : 'Упаковать и добавить'}</Button></Space>
        </Form>}
        {(error || build.error) && <Alert className="tool-packaging__error" type="error" role="alert" showIcon message={error || build.error} />}
    </Modal>;
};
