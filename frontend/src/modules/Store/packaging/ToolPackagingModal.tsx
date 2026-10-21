import { FeatureButton, FeatureAvailabilityNotice, useFeatureAvailability } from '../../../features/FeatureFlags/FeatureAvailability';
import { Alert, Button, Collapse, Form, Input, Modal, Radio, Space, Typography } from 'antd';
import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../../../features/UserBlock/useAuthRequestOwner';
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
import { PackagingBuildStatus } from './PackagingBuildStatus';
import { PackagingSummary } from './PackagingSummary';
import { SourceEntrypointChoice } from './SourceEntrypointChoice';
import { ReleaseAssetChoice } from './ReleaseAssetChoice';
import { SourceArchiveUploader } from './SourceArchiveUploader';
import { useSourceUpload } from './useSourceUpload';
import { uploadedBuildSource } from './uploadTypes';
import {createPythonSourceUpload,isPythonSourceUpload} from './pythonSourceUpload';
import { packagingFilesMetadata, packagingReferenceSource, type PackagingSourceMode } from './packagingDraft';
import {skillPackagingSource} from './skillPackagingSource';
import type { PackagingFilesResult } from './sourceFiles';
import type { NpmPackageMetadata, PackagingKind, RepositoryRelease } from './types';
import './ToolPackaging.less';

interface Props { open: boolean; start?: {source:'files'}; scope: string; projectId?: string; onClose: () => void; onPublished: (id: string, current: () => boolean, kind?: PackagingKind) => Promise<void> }
const { Paragraph } = Typography;

/** Упаковка и публикация выполняются одной серверной операцией, с возобновляемым прогрессом. */
export const ToolPackagingModal: FC<Props> = ({ open, start, scope, projectId, onClose, onPublished }) => {
    const { captureOwner } = useAuthRequestOwner();
    const [source, setSource] = useState<PackagingSourceMode>('npm');
    const [specifier, setSpecifier] = useState('');
    const [npmEntry, setNpmEntry] = useState<{ specifier: string; value: string }>();
    const [repositoryUrl, setRepositoryUrl] = useState('');
    const [repositoryRef, setRepositoryRef] = useState('');
    const [subdirectory, setSubdirectory] = useState('');
    const [repositoryEntrypoint, setRepositoryEntrypoint] = useState('');
    const [repositoryEntry, setRepositoryEntry] = useState<{ revision: string; value: string }>();
    const [repositoryRelease, setRepositoryRelease] = useState<{ url: string; value: RepositoryRelease }>();
    const [uploadEntry, setUploadEntry] = useState<{id:string;value:string}>();
    const [kind, setKind] = useState<PackagingKind>('mcp');
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [uploaded, setUploaded] = useState<PackagingFilesResult>();
    const [archiveName, setArchiveName] = useState('');
    const [entrypoint, setEntrypoint] = useState('');
    const [reading, setReading] = useState(false);
    const [preparing, setPreparing] = useState(false);
    const [error, setError] = useState('');
    const archiveRequest = useRef<AbortController>();
    const alive = useRef(true);
    const readRequest = useRef(0);
    const preparation = useRef(0);
    const manualEntrypoint = useRef(false);
    const explicitKind = useRef<{ source: string; package?: string }>();
    const npm = useNpmMetadata(specifier);
    const release = repositoryRelease?.url === repositoryUrl.trim() ? repositoryRelease.value : undefined;
    const repository = useRepositoryMetadata({ url: repositoryUrl, ref: repositoryRef, subdirectory, entrypoint: repositoryEntrypoint, release });
    const build = useToolBuild(scope);
    const upload = useSourceUpload(scope, captureOwner);
    const appliedStart = useRef<typeof start>();
    const view = useMemo(() => ({}), [open, scope, projectId, captureOwner]);
    const currentView = useRef(view);
    currentView.current = view;
    const closeRevision = useRef(0);
    const resetRequest = useRef<{ view: object; closed: number }>();
    const [resettingRequest, setResettingRequest] = useState<typeof resetRequest.current>();
    const resetting = resettingRequest?.view === view && resettingRequest.closed === closeRevision.current;
    // Возврат к той же форме после смены контекста не возобновляет прежний GET карточки.
    const openingView = useMemo(() => ({ request: undefined as symbol | undefined }), [open, scope, projectId, captureOwner, build.job?.id, build.job?.result?.catalogId]);
    const currentOpeningView = useRef(openingView);
    currentOpeningView.current = openingView;
    const [openingRequest, setOpeningRequest] = useState<typeof openingView>();
    const opening = openingRequest === openingView && !!openingView.request;
    const busy = build.submitting || build.active || preparing || resetting || reading || source === 'upload' && upload.busy;
    const metadata = source === 'npm' ? npm.metadata : source === 'repository' ? repository.metadata : undefined;
    const selectedUploadEntry = upload.upload?.metadata?.candidates.includes(uploadEntry?.id === upload.upload.id ? uploadEntry.value : '') ? uploadEntry!.value : upload.upload?.metadata?.entrypoint || '';
    const sourceKey = source === 'npm' ? `npm:${specifier.trim()}` : source === 'repository' ? `repository:${JSON.stringify([repositoryUrl.trim(), repositoryRef.trim(), subdirectory.trim(), repositoryEntrypoint.trim(), release])}` : source === 'upload' ? `upload:${upload.upload?.id ?? ''}:${selectedUploadEntry}` : 'files';
    const readSourceKey=useRef(sourceKey);
    readSourceKey.current=sourceKey;
    const metadataIdentity = source === 'npm' && npm.metadata ? `npm:${npm.metadata.package}` : source === 'repository' && repository.metadata ? `repository:${repository.metadata.url}:${repository.metadata.subdirectory ?? ''}` : undefined;
    const revision = (value: NonNullable<typeof repository.metadata>): string => JSON.stringify([value.url, value.commit, value.subdirectory, value.release]);
    const repositoryRevision = repository.metadata ? revision(repository.metadata) : '';
    const repositoryRuntime = source === 'repository' && !!repository.metadata?.adapter;
    const selectedRepositoryEntry = repositoryEntry?.revision === repositoryRevision ? repositoryEntry.value : repository.metadata?.entrypoint || '';
    const npmEntrypoint = (value: NpmPackageMetadata): string => npmEntry?.specifier === value.specifier && value.candidates.includes(npmEntry.value) ? npmEntry.value : value.entrypoint;
    const selectedNpmEntry = npm.metadata ? npmEntrypoint(npm.metadata) : '';
    const filesMetadata = useMemo(() => packagingFilesMetadata(uploaded?.files ?? []), [uploaded]);
    const skillMetadata=useMemo(()=>skillPackagingSource(uploaded?.files??[],{...(name.trim()?{name:name.trim()}:{}),...(description.trim()?{description:description.trim()}:{}),...(entrypoint?{entrypoint}:{})}),[uploaded,name,description,entrypoint]);
    const recommended=useMemo(()=>source==='files'?{recommendedKind:skillMetadata?'skill' as const:'mcp' as const}:metadata,[source,skillMetadata,metadata]);
    const effectiveKind = source === 'upload' ? 'mcp' : source==='npm'&&kind==='skill'?'mcp':packagingKind(kind, recommended, explicitKind.current?.source === sourceKey || !!metadataIdentity && explicitKind.current?.package === metadataIdentity);
    const candidates = useMemo(() => packagingEntrypoints(uploaded?.files ?? [], effectiveKind), [uploaded, effectiveKind]);
    const fileMetadata=effectiveKind==='skill'?skillMetadata:filesMetadata;
    const suggestedName = source === 'npm' ? defaultPackagingTitle(npm.metadata?.package ?? specifier.trim()) : source === 'repository' ? defaultPackagingTitle(repository.metadata?.name || repositoryName(repositoryUrl)) : defaultPackagingTitle(source === 'upload' ? upload.upload?.metadata?.name || (upload.upload?.name || upload.intent?.name || '').replace(/\.(?:zip|tar|tar\.gz|tgz|exe)$/i,'') : fileMetadata?.name || uploaded?.rootName || archiveName.replace(/\.(?:zip|tar|tar\.gz|tgz)$/i, '')) || 'Мой инструмент';
    const suggestedDescription = metadata?.description || (source === 'files' ? fileMetadata?.description : source === 'upload' ? upload.upload?.metadata?.description : '') || '';
    const fileError=source==='files'&&effectiveKind!=='skill'&&uploaded?.files.some(file=>file.encoding)?'Бинарные ресурсы поддерживаются в скиллах. Выберите тип «Скилл» или текстовые исходники инструмента.':'';
    const skillError=source==='files'&&effectiveKind==='skill'?(candidates.length>1&&!entrypoint?'':skillMetadata?.error||(!skillMetadata?'Добавьте SKILL.md и ресурсы скилла.':'')):fileError;
    const sourceReady = source === 'upload' ? upload.upload?.state === 'READY' && !!selectedUploadEntry&&!upload.error&&!upload.blocked : source === 'files' ? !!uploaded?.files.length && !!entrypoint&&!skillError : !!metadata
        && (!metadata.runnableKinds || metadata.runnableKinds.includes(effectiveKind)) && (source === 'npm' ? !!selectedNpmEntry : !repository.metadata?.requiresReleaseChoice && !!selectedRepositoryEntry);
    const hasSource = source === 'npm' ? !!specifier.trim() : source === 'repository' ? !!repositoryUrl.trim() : source === 'upload' ? !!upload.upload : !!uploaded?.files.length;
    const sourceBlocked = (!!metadata || source === 'upload' && upload.upload?.state === 'READY') && !sourceReady;
    const sourceAction = metadata?.runnableKinds?.length === 0 ? 'Нет команды запуска' : source === 'repository' && repository.metadata?.requiresReleaseChoice ? 'Выберите файл релиза' : effectiveKind==='skill'&&candidates.length>1&&!entrypoint?'Выберите скилл':sourceBlocked ? 'Выберите команду запуска' : sourceReady ? 'Упаковать и добавить' : 'Проверить источник';
    const progressStep = build.job || build.active ? 2 : sourceReady ? 1 : 0;

    useEffect(() => { alive.current = true; return () => { alive.current = false; readRequest.current++; archiveRequest.current?.abort(); }; }, []);
    useEffect(()=>{readRequest.current++;archiveRequest.current?.abort();setReading(false);},[view,source]);
    useEffect(() => {
        // A handoff selects the archive picker after recovery, without replacing an existing request.
        if (!open || !start || appliedStart.current===start || build.active || build.draft || build.job || build.unresolved || build.recoveryBlocked || upload.intent) return;
        appliedStart.current=start; setSource(start.source);
    }, [open,start,build.active,build.draft,build.job,build.unresolved,build.recoveryBlocked,upload.intent]);
    useEffect(() => {
        const request = build.draft?.request;
        if (!request) return;
        const restored = request.source;
        setSource(restored.type); setKind(request.kind); setName(request.name); setDescription(request.description);
        if (restored.type === 'npm') {
            setSpecifier(restored.specifier); setNpmEntry(restored.entrypoint ? {specifier:restored.specifier,value:restored.entrypoint} : undefined); explicitKind.current = {source: `npm:${restored.specifier.trim()}`};
        } else if (restored.type === 'repository') {
            setRepositoryUrl(restored.url); setRepositoryRef(restored.ref); setSubdirectory(restored.subdirectory ?? ''); setRepositoryEntrypoint(restored.entrypoint);
            setRepositoryRelease(restored.release ? {url:restored.url.trim(),value:restored.release} : undefined);
            explicitKind.current = {source: `repository:${JSON.stringify([restored.url.trim(), restored.ref.trim(), restored.subdirectory?.trim() ?? '', restored.entrypoint.trim(), restored.release])}`};
        } else if (restored.type === 'upload') {
            setUploadEntry({id:restored.uploadId,value:restored.entrypoint}); void upload.restore(restored);
        } else {
            setUploaded({files: restored.files, skipped: 0}); setEntrypoint(restored.entrypoint); manualEntrypoint.current = true; explicitKind.current = {source: 'files'};
        }
    }, [build.draft]);
    useEffect(() => { if (upload.intent && !build.draft) setSource('upload'); }, [upload.intent, build.draft]);
    useEffect(() => { preparation.current++; setPreparing(false); }, [open, scope, projectId, captureOwner, sourceKey]);
    useEffect(() => {
        if (!manualEntrypoint.current || !candidates.includes(entrypoint)) {
            manualEntrypoint.current = false;
            setEntrypoint(candidates.length === 1 ? candidates[0] : '');
        }
    }, [candidates, entrypoint]);
    useEffect(() => {
        if (!recommended) return;
        const explicit = explicitKind.current?.source === sourceKey || !!metadataIdentity && explicitKind.current?.package === metadataIdentity;
        setKind(current => packagingKind(current, recommended, explicit));
    }, [sourceKey, recommended, metadataIdentity]);
    useEffect(() => {
        if (source === 'repository' && release && open && !build.unresolved && !build.active) void repository.resolve().catch(() => {});
    }, [sourceKey, open, build.unresolved, build.active]);

    const availability = useFeatureAvailability('tool_builds');
    const available = useRef(availability.enabled); available.current = availability.enabled;
    const readFiles = async (input: readonly File[], fromArchive = false): Promise<void> => {
        if (!available.current || !input?.length || busy || build.unresolved || build.recoveryBlocked) return;
        const selected = Array.from(input);
        const request = ++readRequest.current;
        const owns=captureOwner(),closed=closeRevision.current;
        const current=()=>available.current&&alive.current&&request===readRequest.current&&owns()&&currentView.current===view&&closeRevision.current===closed&&readSourceKey.current===sourceKey;
        archiveRequest.current?.abort();
        const controller = new AbortController();
        archiveRequest.current = controller;
        manualEntrypoint.current = false;
        explicitKind.current=undefined;
        setKind('mcp');
        setReading(true); setError(''); setUploaded(undefined); setEntrypoint(''); setArchiveName('');
        try {
            if (fromArchive && selected.length !== 1) throw new Error('Добавьте один архив за раз.');
            const next = fromArchive ? await readPackagingArchive(selected[0], controller.signal) : await readPackagingFiles(selected);
            if(!current())return;
            if(isPythonSourceUpload(next)){
                if(upload.blocked)throw new Error('Сначала восстановите состояние сохранённой загрузки.');
                const file=createPythonSourceUpload(next);
                if(!current())return;
                setReading(false);setSource('upload');setUploadEntry(undefined);
                await upload.select(file);
                return;
            }
            setUploaded(next); setArchiveName(fromArchive ? selected[0].name : '');
        } catch (cause) { if (current()) setError(errorMessage(cause, 'Не удалось прочитать исходники.')); }
        finally { if (current()) setReading(false); }
    };
    const submit = async (): Promise<void> => {
        if (!availability.enabled && !build.unresolved) return;
        if (busy) return;
        if (build.unresolved) { await build.retrySaved(); return; }
        const request = ++preparation.current;
        const owns = captureOwner();
        const current = () => alive.current && request === preparation.current && owns();
        const checked = sourceReady;
        setPreparing(true); setError('');
        try {
            // Ошибка предпроверки уже показана у источника и принадлежит его текущему значению.
            const npmMetadata = source === 'npm' ? await npm.resolve().catch(() => undefined) : undefined;
            const repositoryMetadata = source === 'repository' ? await repository.resolve().catch(() => undefined) : undefined;
            if (source === 'npm' && !npmMetadata || source === 'repository' && !repositoryMetadata) return;
            if (!current()) return;
            // Первый шаг проверяет источник и показывает карточку до отправки тяжёлой сборки.
            if (!checked && !build.unresolved) return;
            const resolved = npmMetadata || repositoryMetadata;
            const npmSelected = npmMetadata ? npmEntrypoint(npmMetadata) : '';
            if (resolved?.runnableKinds?.length === 0 || repositoryMetadata?.requiresReleaseChoice) return;
            if (npmMetadata && !npmSelected) throw new Error('Выберите команду запуска npm-пакета.');
            const title = packagingTitle(name, npmMetadata?.package || repositoryMetadata?.name || suggestedName);
            const summary = description.trim() || resolved?.description?.trim() || (source === 'files' ? fileMetadata?.description : source === 'upload' ? upload.upload?.metadata?.description?.trim() : '') || `Инструмент ${title} для OpenCode.`;
            if (summary.length > 2000) throw new Error('Описание — до 2000 символов.');
            if(skillError)throw new Error(skillError);
            if (source === 'files' && (!uploaded?.files.length || !entrypoint)) throw new Error(effectiveKind==='skill'?'Выберите папку скилла с SKILL.md.':'Выберите исходники и файл запуска.');
            const identity = npmMetadata ? `npm:${npmMetadata.package}` : repositoryMetadata ? `repository:${repositoryMetadata.url}:${repositoryMetadata.subdirectory ?? ''}` : undefined;
            const explicit = explicitKind.current?.source === sourceKey || !!identity && explicitKind.current?.package === identity;
            // POST принадлежит хуку; поздний ответ не удерживает подготовку следующей формы.
            void build.submit({ name: title, description: summary, kind: source === 'upload' ? 'mcp' : source==='files'?effectiveKind:packagingKind(source==='npm'&&kind==='skill'?'mcp':kind, resolved, explicit),
                source: source === 'upload' ? uploadedBuildSource(upload.upload!,selectedUploadEntry) : npmMetadata ? { type: 'npm', specifier: npmMetadata.specifier, entrypoint: npmSelected } : repositoryMetadata ? repositoryBuildSource(repositoryMetadata, repositoryEntry?.revision === revision(repositoryMetadata) ? repositoryEntry.value : repositoryMetadata.entrypoint) : { type: 'files', files: uploaded!.files, entrypoint } });
        } catch (cause) { if (current()) setError(errorMessage(cause, 'Не удалось начать упаковку.')); }
        finally { if (current()) setPreparing(false); }
    };
    const openPublished = async (): Promise<void> => {
        const owns = captureOwner();
        if (!open || !build.job?.result || openingView.request || !owns()) return;
        const request = Symbol();
        openingView.request = request;
        const current = () => alive.current && owns() && currentOpeningView.current === openingView && openingView.request === request;
        setOpeningRequest(openingView); setError('');
        try { await onPublished(build.job.result.catalogId, current,build.job.result.kind); }
        catch (cause) { if (current()) setError(errorMessage(cause, 'Инструмент опубликован. Не удалось открыть карточку — обновите каталог.')); }
        finally { if (current()) { openingView.request = undefined; setOpeningRequest(undefined); } }
    };
    const invalidateOpening = (): void => { openingView.request = undefined; setOpeningRequest(undefined); };
    const close = (): void => { closeRevision.current++; preparation.current++; setPreparing(false); invalidateOpening(); onClose(); };
    const reset = async (): Promise<void> => {
        if (resetRequest.current?.view === view && resetRequest.current.closed === closeRevision.current) return;
        const flight = { view, closed: closeRevision.current };
        resetRequest.current = flight; setResettingRequest(flight);
        const request = ++preparation.current;
        const owns = captureOwner();
        const current = () => alive.current && owns() && currentView.current === view && flight.closed === closeRevision.current;
        invalidateOpening(); setError('');
        const succeeded = build.job?.state === 'SUCCEEDED';
        try {
            if (await build.reset() === false || !current() || request !== preparation.current) return;
            if (succeeded) {
                // Forgetting our upload changes sourceKey; the view fence still protects close/owner/project changes.
                if (!await upload.forget() || !current()) return;
                setSpecifier(''); setNpmEntry(undefined); setRepositoryUrl(''); setRepositoryRef(''); setSubdirectory(''); setRepositoryEntrypoint(''); setRepositoryEntry(undefined); setRepositoryRelease(undefined); setUploadEntry(undefined);
                setName(''); setDescription(''); setUploaded(undefined); setArchiveName(''); setEntrypoint(''); setKind('mcp'); setSource('npm'); explicitKind.current = undefined;
            }
        } finally {
            if (resetRequest.current === flight) { resetRequest.current = undefined; setResettingRequest(undefined); }
        }
    };
    const pasteReference = (value: string): boolean => {
        const detected = packagingReferenceSource(value);
        if (!detected || detected === source) return false;
        if (detected === 'npm') setSpecifier(value.trim()); else setRepositoryUrl(value.trim());
        setSource(detected); setError(''); return true;
    };

    const showingProgress = !!build.job || build.active;
    const actions = <Space wrap className="tool-packaging__actions">
        <Button disabled={false} onClick={close}>{showingProgress ? 'Скрыть' : 'Закрыть'}</Button>
        {showingProgress ? <>
            {build.job?.state === 'SUCCEEDED' && <Button type="primary" loading={opening} onClick={() => { void openPublished(); }}>Открыть в каталоге</Button>}
            {build.job && !build.active && <Button disabled={build.submitting || resetting} loading={build.submitting || resetting} onClick={() => { void reset(); }}>{build.job.state === 'FAILED' ? 'Вернуться к исходникам' : 'Упаковать ещё'}</Button>}
        </> : <FeatureButton features={['tool_builds']} type="primary" onClick={() => { void submit(); }} loading={preparing || build.submitting} disabled={busy || build.recoveryBlocked || (build.unresolved ? !build.draft : !hasSource || sourceBlocked || (source === 'files' || source === 'upload') && !sourceReady)}>{build.unresolved ? 'Повторить сохранённый запрос' : sourceAction}</FeatureButton>}
    </Space>;

    return <Modal open={open} title="Упаковать инструмент" width={680} footer={actions} onCancel={close} className="tool-packaging" style={{ top: 32 }}>
        <FeatureAvailabilityNotice features={['tool_builds']}/>
        <ol className="tool-packaging__steps" aria-label="Этапы упаковки">{['Источник', 'Проверка', 'Добавление'].map((label, index) => <li key={label} aria-current={progressStep === index ? 'step' : undefined} className={progressStep >= index ? 'is-current' : ''}><span aria-hidden="true">{index + 1}</span>{label}</li>)}</ol>
        {build.unresolved && <Alert className="tool-packaging__error" type="warning" showIcon message="Результат первого запроса ещё неизвестен"
            description={<>
                <div>{build.draft ? 'Точный запрос и исходники восстановлены. Можно проверить состояние или повторить тот же запрос. Изменить его до выяснения результата нельзя.' : 'Исходный запрос недоступен. Можно проверить состояние сохранённого UUID; другая форма под ним не отправится.'}</div>
                <Button className="tool-packaging__recheck" onClick={build.recheck}>Проверить сохранённый запрос</Button>
            </>} />}
        {build.recoveryBlocked && <Button onClick={build.retryRecovery}>Повторить восстановление запроса</Button>}
        {showingProgress ? <PackagingBuildStatus active={open} job={build.job} name={name || suggestedName || 'Сборка инструмента'} /> : <Form layout="vertical" onFinish={() => { void submit(); }} disabled={busy || build.unresolved || build.recoveryBlocked}>
            <Paragraph type="secondary">Добавьте MCP, плагин или скилл. Мы определим тип и данные карточки по источнику. SKILL.md найдётся и во вложенной папке архива; если скиллов несколько, выберите нужный.</Paragraph>
            <Form.Item label="Откуда добавить инструмент"><Radio.Group aria-label="Источник инструмента" value={source} onChange={event => { setSource(event.target.value);if(event.target.value==='npm'||event.target.value==='upload'){setKind('mcp');}setError(''); }} options={[{ label: 'npm', value: 'npm' }, { label: 'GitHub', value: 'repository' }, { label: 'Архив и файлы', value: 'files' }, {label:'Архив MCP',value:'upload'}]} optionType="button" className="tool-packaging__sources" /></Form.Item>
            {source === 'npm' ? <>
                <Form.Item label="Пакет или ссылка npm" extra="Версия закрепится перед сборкой. Можно указать package@version.">
                    <Input.Search aria-label="npm-пакет или ссылка" value={specifier} onChange={event => setSpecifier(event.target.value)} placeholder="Например, opencode-snip" loading={npm.loading} enterButton="Проверить"
                        onPaste={event => { if (pasteReference(event.clipboardData.getData('text'))) event.preventDefault(); }}
                        onPressEnter={event => event.preventDefault()} onBlur={() => { if (specifier.trim()) void npm.resolve().catch(() => {}); }} onSearch={() => { void npm.resolve(true).catch(() => {}); }} />
                </Form.Item>
                {npm.metadata && <NpmMetadataDetails metadata={npm.metadata} />}
                {npm.metadata && <SourceEntrypointChoice label="Команда npm-пакета" candidates={npm.metadata.candidates} value={selectedNpmEntry} onChange={value => setNpmEntry({specifier:npm.metadata!.specifier,value})} />}
                {npm.error && <Alert type="error" role="alert" showIcon message={npm.error} description="Исправьте название или ссылку и нажмите «Проверить» ещё раз. Сборка ещё не запущена." />}
                <Paragraph type="secondary">Скиллы добавляются из GitHub или во вкладке «Архив и файлы» — SKILL.md с ресурсами, без npm и команды запуска.</Paragraph>
            </> : source === 'repository' ? <>
                <Form.Item label="Ссылка на GitHub" extra="Публичная HTTPS-ссылка на репозиторий, папку, SKILL.md, файл запуска или поставку из Releases. Без токена.">
                    <Input.Search aria-label="Ссылка на репозиторий GitHub" value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repository" loading={repository.loading} enterButton="Проверить"
                        onPaste={event => { if (pasteReference(event.clipboardData.getData('text'))) event.preventDefault(); }}
                        onPressEnter={event => event.preventDefault()} onBlur={() => { if (repositoryUrl.trim()) void repository.resolve().catch(() => {}); }} onSearch={() => { void repository.resolve(true).catch(() => {}); }} />
                </Form.Item>
                <Paragraph type="secondary">Скилл определим по SKILL.md. Для набора скиллов вставьте ссылку на папку нужного скилла или его SKILL.md. JS, TypeScript и Python MCP упакуем из исходников; другим языкам нужна готовая поставка.</Paragraph>
                <Collapse ghost className="tool-packaging__details"><Collapse.Panel header="Ветка и подпапка" key="repository">
                    <Form.Item label="Ветка, тег или commit" extra="По умолчанию — основная ветка репозитория."><Input aria-label="Ветка, тег или commit" value={repositoryRef} onChange={event => setRepositoryRef(event.target.value)} placeholder="Например, main или v1.0.0" /></Form.Item>
                    <Form.Item label="Подпапка" extra="Для инструмента внутри monorepo."><Input aria-label="Подпапка репозитория" value={subdirectory} onChange={event => setSubdirectory(event.target.value)} placeholder="Например, packages/my-tool" /></Form.Item>
                    <Form.Item label={effectiveKind==='skill'?'Инструкция скилла':repositoryRuntime ? 'Рецепт поставки' : 'Файл запуска или рецепт'} extra="По умолчанию определяется автоматически."><Input aria-label={repositoryRuntime ? 'Рецепт поставки репозитория вручную' : 'Файл запуска репозитория вручную'} value={repositoryEntrypoint} onChange={event => { setRepositoryEntrypoint(event.target.value); setRepositoryEntry(undefined); }} placeholder={effectiveKind==='skill'?'SKILL.md':repositoryRuntime ? 'neurocenter.tool.json' : 'src/server.ts'} /></Form.Item>
                </Collapse.Panel></Collapse>
                {repository.metadata && <RepositoryMetadataDetails metadata={repository.metadata} entrypoint={selectedRepositoryEntry} />}
                {repository.metadata && <ReleaseAssetChoice metadata={repository.metadata} onChange={value => { setRepositoryRelease({url:repositoryUrl.trim(),value}); setRepositoryEntrypoint(''); setRepositoryEntry(undefined); }} />}
                {repository.metadata && (!repositoryRuntime || !!repository.metadata.release) && <SourceEntrypointChoice label="Файл запуска репозитория" candidates={repository.metadata.candidates} value={selectedRepositoryEntry} onChange={value => {
                    if (repository.metadata?.release) { setRepositoryEntrypoint(value); setRepositoryEntry(undefined); }
                    else setRepositoryEntry({ revision: repositoryRevision, value });
                }} />}
                {repository.error && <Alert type="error" role="alert" showIcon message={repository.error} description="Проверьте ссылку. Для инструмента в подпапке или другой ветке откройте «Ветка и подпапка», затем повторите проверку." />}
            </> : source === 'upload' ? <><SourceArchiveUploader upload={upload} entrypoint={selectedUploadEntry} onEntrypointChange={value => setUploadEntry(upload.upload ? {id:upload.upload.id,value} : undefined)} disabled={!availability.enabled || build.submitting || build.active || preparing || resetting || build.unresolved || build.recoveryBlocked} /><Paragraph type="secondary">Архив скилла или JS / TypeScript плагина добавьте во вкладке «Архив и файлы». Исходники Python MCP можно загрузить здесь, включая архив с вложенной папкой. Если передача Python-исходников прервалась, повторно выберите исходный архив, папку или файлы во вкладке «Архив и файлы» — продолжим ту же загрузку.</Paragraph></> : <>
                <Form.Item label="Исходники или скилл"><SourceFilesPicker disabled={!availability.enabled || busy || build.unresolved || build.recoveryBlocked} reading={reading} uploaded={uploaded} archiveName={archiveName} onSelect={(input, fromArchive) => { void readFiles(input, fromArchive); }} /></Form.Item>
                <Paragraph type="secondary">Папки внутри архива сохраняются. Найдём SKILL.md, а scripts, references и assets рядом с ним станут ресурсами скилла, включая PNG и PDF. Если найдём несколько скиллов, покажем их пути для выбора.</Paragraph>
                <Paragraph type="secondary" className="tool-packaging__language-note">Python MCP определим в архиве, папке или выбранных файлах и автоматически добавим интерпретатор с зависимостями. Для готовых программ других языков используйте GitHub Release или «Архив MCP».</Paragraph>
                {uploaded && <SourceEntrypointChoice skill={effectiveKind==='skill'} label={effectiveKind==='skill'?'Скилл в исходниках':'Файл запуска'} candidates={candidates} value={entrypoint} onChange={value => { manualEntrypoint.current = true; setEntrypoint(value); }} />}
                {skillError&&<Alert type="error" role="alert" showIcon message={skillError}/>}
                {uploaded && !candidates.length&&!skillError && <Alert type="warning" showIcon message="В исходниках нет SKILL.md или файла запуска JS / TypeScript" description="Выберите папку одного скилла или исходники инструмента. Для Python MCP или готовой программы используйте GitHub или «Архив MCP»." />}
            </>}
            {sourceReady && <PackagingSummary name={name.trim() || suggestedName} description={description.trim() || suggestedDescription} kind={effectiveKind} entrypoint={source === 'files' && (candidates.length === 1||effectiveKind==='skill') ? entrypoint : undefined} />}
            <Collapse ghost className="tool-packaging__details"><Collapse.Panel header="Настроить карточку и тип инструмента" key="details">
                <Form.Item label="Тип инструмента" extra={recommended?.recommendedKind ? 'Тип определён по источнику. Можно изменить вручную.' : 'MCP предоставляет инструменты; плагин расширяет OpenCode; скилл содержит инструкции и ресурсы.'}><Radio.Group aria-label="Тип инструмента" value={effectiveKind} onChange={event => { explicitKind.current = { source: sourceKey, package: metadataIdentity }; setKind(event.target.value); }} options={[{ label: 'MCP', value: 'mcp', disabled: !!metadata?.runnableKinds && !metadata.runnableKinds.includes('mcp') }, { label: 'Плагин OpenCode', value: 'plugin', disabled: repositoryRuntime || source === 'upload' || !!metadata?.runnableKinds && !metadata.runnableKinds.includes('plugin') },{label:'Скилл',value:'skill',disabled:source==='npm'||source==='upload'||repositoryRuntime||!!metadata?.runnableKinds&&!metadata.runnableKinds.includes('skill')}]} /></Form.Item>
                <Form.Item label="Название в каталоге"><Input aria-label="Название в каталоге" value={name} maxLength={128} onChange={event => setName(event.target.value)} placeholder={suggestedName || 'Название из пакета'} /></Form.Item>
                <Form.Item label="Описание"><Input.TextArea aria-label="Описание инструмента" rows={2} value={description} maxLength={2000} onChange={event => setDescription(event.target.value)} placeholder={suggestedDescription || 'Кратко опишите инструмент'} /></Form.Item>
            </Collapse.Panel></Collapse>
        </Form>}
        {(error || build.error) && <Alert className="tool-packaging__error" type="error" role="alert" showIcon message={error || build.error} />}
    </Modal>;
};
