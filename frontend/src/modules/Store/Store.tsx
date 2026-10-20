import { Alert, Button, Checkbox, Col, Empty, Input, message, Modal, Radio, Row, Select, Space, Spin, Typography } from 'antd';
import { FC, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { useHistory, useLocation } from 'react-router-dom';

import bffApi from '../../core/api/bff';
import { baseRoutes } from '../../core/baseRoutes';
import { PageHeading } from '../../common/components/PageHeading';
import { errorMessage } from '../../common/utils/errorMessage';
import './Store.less';
import { isMainAdminRole, roleLevel, projectRoleLevel } from '../../features/UserBlock/roles';
import { RootState } from '../../store';

import AppCard, { type IStoreApp, type TStoreKind } from './AppCard';
import { fromPlugin, fromSkill, pluralProjects, skillProject, canEditTool, projectSkillReferenceBlocker, isToolInProject, projectAssetForTool } from './storeHelpers';
import StoreCreateModal from './StoreCreateModal';
import StoreDetailsModal from './StoreDetailsModal';
import StoreEditModal from './StoreEditModal';
import {useBridge} from '../../features/McpBridge/useBridge';
import {BridgeConnection} from '../../features/McpBridge/BridgeConnection';
import {bridgeApi} from '../../features/McpBridge/api';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import { ProjectKnowledgeLink } from './ProjectKnowledgeLink';
import {LocalInstallations} from '../../features/McpBridge/LocalInstallations';
import {currentInstallation, isPending, latestAssetJob} from '../../features/McpBridge/installationHelpers';
import { installationBlocker } from '../../features/McpBridge/readiness';
import { useInstallPlan } from './installPlans/useInstallPlan';
import { InstallPlanModal } from './installPlans/InstallPlanModal';
import { InstallPlanFailureModal } from './installPlans/InstallPlanFailureModal';
import { runtimeArtifactBlocker } from '../../features/McpBridge/runtimeArtifacts';
import { ProjectInstallationReadiness } from '../../features/McpBridge/ProjectInstallationReadiness';
import { pendingLocalJob } from '../../features/McpBridge/operationHelpers';
import { useAvailableProjects } from '../Projects/useAvailableProjects';
import { projectBindingUrl } from '../Projects/projectNavigation';
import { storeProjectQuery, storeQueryUrl, storeSearchQuery } from './storeQuery';
import { ToolPackagingModal } from './packaging/ToolPackagingModal';
import { mergeProjectCatalog } from './projectCatalogSnapshots';
import { useProjectCatalog } from './useProjectCatalog';
import { useAuthRequestOwner } from '../../features/UserBlock/useAuthRequestOwner';
import { createProjectCatalogBatchController } from './projectCatalogBatch';
import UnavailableProjectAssets from './UnavailableProjectAssets';
import { unavailableProjectAssets } from './selectUnavailableProjectAssets';
import { prepareProjectCatalogInstall } from './prepareProjectCatalogInstall';
import { loadCompletePluginCatalog } from './loadCompletePluginCatalog';
import { CatalogTabs } from './CatalogTabs';
import { catalogSection } from './catalogSection';
import { selectStoreTarget, storeProjectAssetRequest, visibleStoreApps } from './storeCatalogView';

const { Text, Paragraph } = Typography;

/** Последний выбранный проект — удобство интерфейса, а не источник прав доступа. */
function readSavedTarget(): string | null {
    try { return localStorage.getItem('neurocenter.install-project'); } catch { return null; }
}

type TFilter = 'all' | TStoreKind;

/** Пропсы магазина: общий экран или встраивание в карточку проекта (вкладка). */
interface IStoreProps {
    /** Зафиксированный проект (вкладка «Магазин» на карточке проекта). */
    presetTarget?: string;
    /** Встроен в другую страницу: убрать внешний заголовок и селектор проекта. */
    embedded?: boolean;
}

/**
 * Экран «Магазин»: витрина приложений (скиллы / MCP / плагины) в стиле app-store.
 * Общий и проектные каталоги; главный админ публикует, админ проекта выбирает инструменты команды.
 * Локальная установка не подменяется записью файлов на сервере.
 *
 * @component
 * @returns JSX-элемент витрины
 */
const Store: FC<IStoreProps> = ({ presetTarget, embedded }) => {
    const { captureOwner } = useAuthRequestOwner();
    const location = useLocation();
    const history = useHistory();
    const user = useSelector((state: RootState) => state.userBlock.user);
    const level = roleLevel(user?.activeRole);
    const canBrowseCommon = level >= 3;
    const isMain = isMainAdminRole(user?.activeRole);
    const { projects, ready: projectsReady, loading: projectsLoading, error: projectLoadError, scope: accessKey, refresh: refreshProjects } = useAvailableProjects();

    const [commonCatalog, setCatalog] = useState<IStoreApp[]>([]);
    const requestedTarget = presetTarget ?? storeProjectQuery(location.search);
    const selectedTarget = selectStoreTarget(projectsReady ? projects : [], requestedTarget, user);
    const targetProject = selectedTarget.project;
    const target = targetProject?.name ?? null;
    const projectLevel = projectsReady ? selectedTarget.level : 0;
    const canManage = projectLevel >= 3;
    const canInstall = projectLevel >= 2;
    const { assets, loading: projectLoading, ready: projectCatalogReady, error: projectCatalogError, refresh: loadProject } = useProjectCatalog(targetProject?.id, accessKey);
    const projectCatalogUsable = projectCatalogReady && !projectCatalogError;
    const catalog=useMemo(()=>mergeProjectCatalog(commonCatalog,assets),[commonCatalog,assets]);
    const [filter, setFilter] = useState<TFilter>('all');
    const query = storeSearchQuery(location.search);
    const [search, setSearch] = useState(() => query);
    const [installedOnly, setInstalledOnly] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const catalogRequest = useRef(0);
    const [loading, setLoading] = useState(true);
    const [installing, setInstalling] = useState<string | null>(null);

    const [picker, setPicker] = useState<{ app: IStoreApp } | null>(null);
    const [pickerSelected, setPickerSelected] = useState<string[]>([]);
    const [pickerConfirming, setPickerConfirming] = useState(false);
    const pickerBatch = useMemo(() => createProjectCatalogBatchController(), []);

    const [viewApp, setViewApp] = useState<IStoreApp | null>(null);
    const [editApp, setEditApp] = useState<IStoreApp | null>(null);

    const [createOpen, setCreateOpen] = useState(false);
    const [packagingOpen, setPackagingOpen] = useState(false);
    const projectsInitialized = useRef(false);
    useEffect(() => { setSearch(query); }, [query]);
    const changeSearch = (value: string): void => {
        setSearch(value);
        const current = history.location;
        if (!embedded && current.pathname === baseRoutes.store) { history.replace(storeQueryUrl(current.search, { query: value }, current.hash)); }
    };
    const bridge=useBridge();
    const binding=bridge.device?.report.bindings?.find(item=>item.projectId===targetProject?.id&&item.valid!==false);
    const bridgeInstallError = installationBlocker(bridge.device);
    const installTarget=(app:IStoreApp)=>({deviceId:bridge.device?.id,projectId:targetProject?.id,bindingId:binding?.bindingId ?? null,assetId:app.id,assetKind:app.kind});
    const assetJobFor=(app:IStoreApp)=>latestAssetJob(bridge.jobs,installTarget(app));
    const localActionFor=(app:IStoreApp)=>{const row=currentInstallation(bridge.installations,installTarget(app));return row?pendingLocalJob(bridge.jobs,row):undefined;};
    const jobFor=(app:IStoreApp)=>{const job=assetJobFor(app);return job?.kind==='install'&&(Number(job.version)===app.version||isPending(job))?{...job,message:`Версия ${job.version}: ${job.message}`}:undefined;};
    const localPlans = useInstallPlan({
        scopeKey: JSON.stringify([accessKey, targetProject?.id, bridge.device?.id, binding?.bindingId,
            canInstall, bridgeInstallError, bridge.jobsReady, bridge.installationsReady, projectCatalogUsable]),
        deviceId: bridge.device?.id, projectId: targetProject?.id, bindingId: binding?.bindingId,
        ready: !!bridge.device && !bridgeInstallError && !!targetProject && canInstall && !!binding
            && bridge.jobsReady && bridge.installationsReady && projectCatalogUsable,
        canApprove: canManage,
        captureOwner,
        prepareCatalog: (app, current) => prepareProjectCatalogInstall({
            inProject: isToolInProject(app, targetProject?.id, assets, catalog), canManage, current,
            add: () => bffApi.addProjectAsset(...storeProjectAssetRequest(targetProject!, app)),
            refresh: loadProject,
        }),
        isPending: app => isPending(assetJobFor(app)) || !!localActionFor(app),
        planBlocker: plan => runtimeArtifactBlocker(plan,bridge.device),
        reload: bridge.reload,
    });
    const localBusy = localPlans.busy;
    const localInstall = localPlans.install;
    useEffect(() => {
        projectsInitialized.current = false;
        setViewApp(null); setEditApp(null); setPicker(null); setPickerSelected([]); setCreateOpen(false);
        setInstalling(null); setPickerConfirming(false);
        pickerBatch.reset();
    }, [accessKey, pickerBatch]);
    useEffect(() => {
        if (!projectsReady || projectsInitialized.current) { return; }
        projectsInitialized.current = true;
        if (embedded || presetTarget || requestedTarget !== null) { return; }
        const saved = readSavedTarget();
        const initial = selectStoreTarget(projects, saved, user).project
            ?? (projects.length === 1 ? projects[0] : undefined);
        if (initial) {
            history.replace(storeQueryUrl(location.search, { project: initial.id }, location.hash));
        }
    }, [projects, projectsReady, accessKey, embedded, presetTarget, requestedTarget, history, location.search, location.hash, user]);

    const loadCatalog = useCallback(async (): Promise<void> => {
        const isOwnerCurrent = captureOwner();
        if (!isOwnerCurrent()) { return; }
        const request = ++catalogRequest.current;
        const isCurrent = (): boolean => request === catalogRequest.current && isOwnerCurrent();
        setLoading(true);
        setLoadError(false);
        try {
            const [plugins, skills] = await Promise.all([
                loadCompletePluginCatalog(bffApi.listAiPlugins, isCurrent),
                bffApi.listSkills({}),
            ]);
            if (!isCurrent() || plugins === null) { return; }
            const nextCatalog = [
                ...plugins.map(fromPlugin),
                ...((skills ?? [])).map(fromSkill),
            ];
            setCatalog(nextCatalog);
            setViewApp(previous => previous?.projectManifest?previous:previous ? (nextCatalog.find(item => item.id === previous.id && item.kind === previous.kind) || previous) : null);
        } catch {
            if (isCurrent()) { setLoadError(true); setCatalog([]); }
        } finally {
            if (isCurrent()) { setLoading(false); }
        }
    }, [accessKey, captureOwner]);

    useEffect(() => {
        void loadCatalog();
        return () => { catalogRequest.current += 1; };
    }, [ loadCatalog ]);

    useSectionUpdates(['catalog'],()=>{void loadCatalog();void loadProject();});

    const openEdit = (app: IStoreApp): void => setEditApp(app);

    const isInProject = useCallback((app: IStoreApp): boolean =>
        isToolInProject(app, targetProject?.id, assets, catalog), [ assets, targetProject, catalog ]);

    const shown = useMemo(() => visibleStoreApps(catalog, {
        projectOnly: !!embedded || !canBrowseCommon, projectSelected: !!target,
        kind: filter, query: search, inProject: isInProject, installedOnly,
    }), [ catalog, target, embedded, canBrowseCommon, filter, search, isInProject, installedOnly ]);

    const switchTarget = useCallback((projectId: string | null): void => {
        try { if (projectId) { localStorage.setItem('neurocenter.install-project', projectId); } else { localStorage.removeItem('neurocenter.install-project'); } } catch { /* Хранилище браузера может быть недоступно. */ }
        history.replace(storeQueryUrl(location.search, { project: projectId, query: search }, location.hash));
    }, [ history, location.search, location.hash, search ]);

    const doInstall = useCallback(async (app:IStoreApp,action:'install'|'uninstall'='install'):Promise<void>=>{
        if(!target || !targetProject || !canManage || !projectCatalogUsable || projectLoading){return;}
        const isCurrent = captureOwner();
        if (!isCurrent()) { return; }
        const blocker = action === 'install' ? projectSkillReferenceBlocker(app, targetProject.id) : null;
        if (blocker) { message.warning(blocker); return; }
        setInstalling(app.id);
        try {
            const assetId = action === 'uninstall' ? projectAssetForTool(app, targetProject.id, assets, catalog)?.assetId ?? app.id : app.id;
            const request = storeProjectAssetRequest(targetProject, app, assetId);
            if(action==='install'){await bffApi.addProjectAsset(...request);}
            else{await bffApi.removeProjectAsset(...request);}
            if (!isCurrent()) { return; }
            message.success(action==='install'?'Добавлено в каталог проекта':'Убрано из каталога проекта');
            await loadProject();
        }catch(error){if(isCurrent()){message.error(errorMessage(error,'Не удалось изменить каталог проекта'));}}
        finally{if(isCurrent()){setInstalling(null);}}
    },[target,targetProject,canManage,assets,catalog,loadProject,projectCatalogUsable,projectLoading,captureOwner]);

    // При открытии окна установки сбрасываем выбор проектов.
    useEffect(() => {
        setPickerSelected([]);
    }, [ picker ]);

    /** Подтвердить установку приложения в выбранные проекты (несколько сразу). */
    const confirmPicker = useCallback(async (): Promise<void> => {
        if (!projectsReady || !picker || pickerSelected.length === 0) {
            return;
        }
        const isCurrent = captureOwner();
        if (!isCurrent()) { return; }
        const blocker = projectSkillReferenceBlocker(picker.app);
        if (blocker) { message.warning(blocker); return; }
        if (pickerSelected.some(projectId => {
            const project = projects.find(item => item.id === projectId);
            return !project || projectRoleLevel(user, project.id) < 3;
        })) {
            message.warning('Выберите проекты, в которых вы управляете каталогом.');
            return;
        }
        await pickerBatch.run({
            projects: pickerSelected,
            add: projectId => bffApi.addProjectAsset(...storeProjectAssetRequest({ id: projectId }, picker.app)),
            isOwnerCurrent: isCurrent,
            onBusyChange: setPickerConfirming,
            onCompleted: async ({ ok, fail }, isCurrentBatch) => {
                if (targetProject && pickerSelected.includes(targetProject.id)) { await loadProject(); }
                if (!isCurrentBatch()) { return; }
                message[fail === 0 ? 'success' : 'warning'](
                    `Добавлено в каталоги: ${ok} из ${pickerSelected.length} ${pluralProjects(pickerSelected.length)}${fail ? `, ошибок: ${fail}` : ''}`,
                );
                if(fail===0){setPicker(null);}
            },
        });
    }, [ projectsReady, picker, pickerSelected, projects, user, targetProject, loadProject, captureOwner, pickerBatch ]);


    // Детали — кликом по карточке (onView); кнопки действий — в одну строку, равной ширины.
    const renderAction=(app:IStoreApp):ReactNode=>{
        const selected=isInProject(app);
        const referenceBlocker=projectSkillReferenceBlocker(app,targetProject?.id);
        const job=assetJobFor(app);
        const pendingAction=localActionFor(app);
        const pending=isPending(job)||!!pendingAction;
        const installation=currentInstallation(bridge.installations,installTarget(app));
        const installLabel=pendingAction&&!['install','uninstall'].includes(pendingAction.kind)?'Дождитесь локального действия':pending?(job?.state==='reconciling'?'Сверяем результат':job?.kind==='uninstall'?'Удаление через мост…':job?.state==='queued'?'В очереди моста':'Устанавливается…'):installation?(installation.version===app.version?'Установить повторно':`Обновить до версии ${app.version}`):'Установить через мост';
        return <Space direction="vertical" style={{width:'100%'}}>
            {app.pinError&&<Text type="warning">{app.pinError}</Text>}
            {selected&&canManage&&targetProject&&commonCatalog.some(item=>item.id===app.id&&item.kind===app.kind&&(app.pinError||item.version!==app.version))&&<Button size="small" block onClick={()=>{
                const current=captureOwner();
                const head=commonCatalog.find(item=>item.id===app.id&&item.kind===app.kind)!,ref=assets.find(item=>item.assetId===app.id&&item.assetKind===app.kind)!;
                Modal.confirm({title:`Закрепить версию ${head.version} в проекте «${target}»?`,content:'Новая установка потребует одобрения этой версии. Файлы на компьютерах остаются на своих версиях.',okText:'Закрепить версию',cancelText:'Отмена',onOk:async()=>{if(!current())return;await bffApi.pinProjectAsset(targetProject.id,{assetId:ref.assetId,assetKind:ref.assetKind,version:head.version,expectedVersion:ref.version??null,expectedManifest:ref.manifest??null});if(current())await loadProject();}});
            }}>{app.pinError?'Подтвердить версию проекта':'Закрепить новую версию'}</Button>}
            {target && canInstall && (selected || canManage && !referenceBlocker) && <Button size="small" block type="primary" disabled={!!app.pinError||!projectCatalogUsable||!!installing||projectLoading||!!bridgeInstallError||!binding||!bridge.device||!bridge.jobsReady||!bridge.installationsReady||!!localBusy||pending} loading={localBusy===app.id||job?.state==='running'} title={bridgeInstallError||(!binding?'Свяжите папку проекта на странице «Проекты»':undefined)} onClick={()=>{void localInstall(app);}}>{installLabel}</Button>}
            {target && canManage && !referenceBlocker && <Button size="small" block loading={installing===app.id} disabled={!!installing||!!localBusy||projectLoading||!projectCatalogUsable}
                onClick={()=>{void doInstall(app,selected?'uninstall':'install');}}>{selected?'Убрать из каталога проекта':'Добавить в каталог проекта'}</Button>}
            {target && canManage && referenceBlocker && skillProject(app) !== targetProject?.id && <Text type="secondary">{referenceBlocker}</Text>}
            {target && selected && canManage && <Button size="small" block disabled={!!localBusy || projectLoading || !projectCatalogUsable}
                onClick={() => { void localPlans.inspect(app); }}>Разрешение версии</Button>}
            {job&&(job.state!=='succeeded'||!installation)&&<Text type={job.state==='failed'?'danger':'secondary'} role="status">{job.message}</Text>}
            {job?.state==='queued'&&<Button size="small" onClick={()=>{void bridgeApi.cancel(job.id).then(()=>bridge.reload()).catch(cause=>message.error(errorMessage(cause,'Не удалось отменить задание.')));}}>Отменить {job.kind==='uninstall'?'удаление':'установку'}</Button>}
            {!target && level>=3 && <>
                <Button size="small" block type="primary" disabled={!projectsReady||!!referenceBlocker} title={referenceBlocker ?? undefined} onClick={()=>setPicker({app})}>Добавить в проекты</Button>
                {referenceBlocker && <Text type="secondary">{referenceBlocker}</Text>}
            </>}
            {canEditTool(user, app) && <Button size="small" block onClick={()=>openEdit(app)}>Редактировать</Button>}
            {!canManage && !isMain && <Text type="secondary">Доступно в каталоге проекта</Text>}
        </Space>;
    };

    /** Недоступное действие объясняется в модалке, где пользователь читает инструмент. */
    const installationUnavailableReason = (app: IStoreApp): string => {
        if(app.pinError)return app.pinError;
        if (!targetProject) {
            return skillProject(app)
                ? 'Для установки выберите исходный проект этого скилла. В другой проект добавьте общий скилл или отдельную копию.'
                : 'Выберите проект в каталоге, чтобы установить инструмент на компьютер.';
        }
        const referenceBlocker = projectSkillReferenceBlocker(app, targetProject.id);
        if (referenceBlocker && skillProject(app) !== targetProject.id) { return referenceBlocker; }
        if (!canInstall) { return 'Установка требует доступной роли разработчика или администратора в выбранном проекте.'; }
        if (!projectCatalogUsable) { return projectCatalogError || 'Дождитесь загрузки каталога выбранного проекта.'; }
        if (!isInProject(app) && !canManage) { return 'Сначала администратор должен добавить инструмент в каталог выбранного проекта.'; }
        if (bridgeInstallError) { return bridgeInstallError; }
        if (!binding) { return 'Свяжите папку выбранного проекта на странице «Проекты».'; }
        if (!bridge.jobsReady || !bridge.installationsReady) { return 'Дождитесь загрузки заданий и установок. При ошибке обновите данные подключения.'; }
        const job = assetJobFor(app);
        return localActionFor(app) ? 'Дождитесь завершения текущего локального действия с этим инструментом.' : isPending(job) && job?.kind === 'uninstall' ? 'Дождитесь завершения удаления или сверки его результата.' : '';
    };

    return (
        <div className="store">
            {!embedded && <PageHeading title="Каталог" description="Соберите инструменты и модели команды в общем и проектных каталогах." actions={isMain && catalogSection(location.search) === 'tools' && <Space wrap><Button onClick={() => setCreateOpen(true)}>Добавить вручную</Button><Button type="primary" onClick={() => setPackagingOpen(true)}>Упаковать инструмент</Button></Space>} />}
            <div className="store__destination">
                <div><Text strong>Каталог проекта</Text><Paragraph type="secondary">{!projectsReady
                    ? projectsLoading ? 'Загружаем доступные проекты…' : 'Загрузите список проектов, чтобы продолжить.'
                    : target ? `Выбран проект «${target}».` : 'Выберите проект, чтобы добавить в его каталог инструменты и модели.'}</Paragraph></div>
                {!embedded && <Select aria-label="Каталог проекта" placeholder="Выберите проект" value={projectsReady ? targetProject?.id : undefined} loading={projectsLoading} disabled={!projectsReady} allowClear showSearch optionFilterProp="label" onChange={(projectId?: string) => switchTarget(projectId ?? null)} options={projects.map(project => ({value:project.id,label:project.name}))} style={{width:260,maxWidth:'100%'}} />}
            </div>
            {projectLoadError && <Alert className="store__projects-error" type={projectsReady?'warning':'error'} showIcon
                message={projectsReady?'Не удалось обновить проекты':'Не удалось загрузить проекты'}
                description={projectsReady?`Показан последний загруженный список проектов. ${projectLoadError}`:projectLoadError}
                action={<Button size="small" loading={projectsLoading} onClick={()=>{void refreshProjects();}}>Повторить загрузку проектов</Button>} />}
            {targetProject && projectCatalogError && <Alert className="store__projects-error" type={projectCatalogReady ? 'warning' : 'error'} showIcon
                message={projectCatalogReady ? 'Не удалось обновить каталог проекта — показаны предыдущие данные' : 'Каталог проекта не загружен'}
                description={projectCatalogError}
                action={<Button size="small" loading={projectLoading} onClick={() => { void loadProject(); }}>Повторить загрузку каталога</Button>} />}
            <CatalogTabs scope={accessKey} projectId={targetProject?.id} projectName={targetProject?.name} embedded={embedded} canManage={canManage} isMain={isMain} tools={<>
            <div style={{marginBottom:16,padding:16,background:'#fff',borderRadius:12}}><BridgeConnection bridge={bridge} compact/>{targetProject && <ProjectInstallationReadiness bridge={bridge} projectId={targetProject.id} canInstall={canInstall} />}</div>
            {targetProject&&bridge.device&&<LocalInstallations key={bridge.device.id+':'+targetProject.id} bridge={bridge} projectId={targetProject.id} canInspect={projectLevel>=1} connectionNoticeVisible canManage={canInstall&&!bridgeInstallError} catalog={catalog} approved={new Set(catalog.filter(isInProject).map(asset=>asset.kind+':'+asset.id))}/>}
            {targetProject && <ProjectKnowledgeLink projectId={targetProject.id} />}
            {loadError && <Alert type="error" showIcon message="Не удалось загрузить каталог" action={<Button size="small" onClick={() => { void loadCatalog(); }}>Повторить</Button>} style={{marginBottom:16}} />}
            <Space style={{ marginBottom: 16 }} wrap>
                <Radio.Group
                    optionType="button"
                    value={ filter }
                    onChange={(e) => setFilter(e.target.value as TFilter)}
                    options={[
                        { value: 'all', label: 'Все' },
                        { value: 'mcp', label: 'MCP' },
                        { value: 'plugin', label: 'Плагины' },
                        { value: 'skill', label: 'Скиллы' },
                    ]}
                />
                <Input.Search
                    allowClear
                    value={search}
                    aria-label="Поиск инструментов"
                    placeholder="Название или описание…"
                    style={{ width: 260 }}
                    onSearch={changeSearch}
                    onChange={(e) => changeSearch(e.target.value)}
                />
                {target && <Checkbox checked={installedOnly} onChange={event => setInstalledOnly(event.target.checked)}>Только в каталоге проекта</Checkbox>}
            </Space>

            {!loading && !loadError && projectCatalogUsable && targetProject && <UnavailableProjectAssets
                key={JSON.stringify([accessKey, targetProject.id])} projectId={targetProject.id} canManage={canManage}
                assets={unavailableProjectAssets(assets, catalog, targetProject.id)} onRemoved={loadProject}
                onRecheck={async () => { await Promise.all([loadCatalog(), loadProject()]); }} />}

            { loading
                ? <Spin style={{ display: 'block', margin: '60px auto' }} />
                : (shown.length === 0
                    ? <Empty description={search || installedOnly ? 'По этим условиям ничего не найдено' : 'Здесь появятся доступные вам инструменты'}><Button onClick={() => { changeSearch(''); setInstalledOnly(false); setFilter('all'); }}>Сбросить фильтры</Button></Empty>
                    : (
                        <Row gutter={[12, 12]} align="stretch">
                            { shown.map(a => (
                                <Col key={ a.id } xs={24} sm={12} xl={8} xxl={6}>
                                    <AppCard app={ a } installed={ !!target && isInProject(a)} action={ renderAction(a) } onView={() => setViewApp(a)} />
                                </Col>
                            )) }
                        </Row>
                    )) }

            <Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
                Инструменты проектного каталога доступны всем участникам проекта. Выбор каталога не запускает локальную установку.
            </Paragraph>
            </>} />

            {/* Выбор проекта для установки (глобальный магазин): мультиселект + подтверждение */}
            <Modal
                open={ !!picker }
                title={picker ? `Добавить «${picker.app.name}» в каталоги проектов` : ''}
                onCancel={() => { if (pickerBatch.canClose()) { setPicker(null); } }}
                closable={!pickerConfirming} keyboard={!pickerConfirming} maskClosable={!pickerConfirming}
                onOk={() => { void confirmPicker(); }}
                okText={ pickerSelected.length > 0 ? `Подтвердить (${pickerSelected.length})` : 'Подтвердить' }
                okButtonProps={{ disabled: !projectsReady || pickerSelected.length === 0 || pickerConfirming || !!(picker && projectSkillReferenceBlocker(picker.app)), loading: pickerConfirming }}
                cancelText="Отмена"
                cancelButtonProps={{ disabled: pickerConfirming }}
                destroyOnClose
            >
                { !projectsReady
                    ? projectsLoading ? <Spin /> : <Text type="secondary">Проекты не загружены. Повторите загрузку проектов.</Text>
                    : projects.length === 0
                    ? <Empty description="Нет доступных проектов" />
                    : !picker
                        ? null
                        : (() => {
                            return (
                                <div>
                                    {projectSkillReferenceBlocker(picker.app) && <Alert type="info" showIcon message={projectSkillReferenceBlocker(picker.app)} style={{marginBottom:12}} />}
                                    <Text type="secondary" style={{ fontSize: 12 }}>
                                        Выберите проекты, в которых вы управляете каталогом. Повторное добавление не создаёт дубль.
                                    </Text>
                                    <Select
                                        mode="multiple"
                                        disabled={pickerConfirming}
                                        style={{ width: '100%', marginTop: 8 }}
                                        placeholder="Проекты"
                                        value={ pickerSelected }
                                        onChange={ (v: string[]) => setPickerSelected(v) }
                                        options={projects.filter(p=>projectRoleLevel(user,p.id)>=3).map(p=>({label:p.name,value:p.id,disabled:!!projectSkillReferenceBlocker(picker.app,p.id)}))}
                                    />
                                </div>
                            );
                        })() }
            </Modal>

            <StoreCreateModal key={'create:' + accessKey} open={createOpen} onClose={() => setCreateOpen(false)} onPackage={()=>{setCreateOpen(false);setPackagingOpen(true);}} onCreated={()=>{changeSearch('');setFilter('all');setInstalledOnly(false);void loadCatalog();}} />
            {isMain && <ToolPackagingModal key={accessKey} open={packagingOpen} scope={accessKey} projectId={targetProject?.id} onClose={() => setPackagingOpen(false)} onPublished={async (id, current) => {
                const owns = captureOwner();
                if (!owns() || !current()) return;
                const app = await bffApi.getAiPlugin(id);
                if (!owns() || !current()) return;
                changeSearch(''); setFilter('all'); setInstalledOnly(false); setPackagingOpen(false);
                void loadCatalog(); setViewApp(fromPlugin(app));
            }} />}

            <StoreDetailsModal viewApp={viewApp} onClose={() => setViewApp(null)} onEdit={viewApp && canEditTool(user, viewApp) ? () => { setEditApp(viewApp); setViewApp(null); } : undefined}
                projectName={target ?? undefined}
                onAddToProject={viewApp && targetProject && canManage && projectCatalogUsable && !isInProject(viewApp) && !projectSkillReferenceBlocker(viewApp, targetProject.id) && (!!bridgeInstallError || !binding || !bridge.jobsReady || !bridge.installationsReady) ? () => { void doInstall(viewApp, 'install'); } : undefined}
                addingToProject={!!installing || projectLoading}
                onChooseProjectFolder={viewApp && targetProject && canInstall && isInProject(viewApp) && bridge.device && !bridgeInstallError && !binding ? () => { setViewApp(null); history.push(projectBindingUrl(targetProject.id)); } : undefined}
                onInstall={viewApp&&!viewApp.pinError&&canInstall&&projectCatalogUsable&&!bridgeInstallError&&binding&&bridge.jobsReady&&bridge.installationsReady&&(isInProject(viewApp)||canManage&&!projectSkillReferenceBlocker(viewApp,targetProject?.id))&&!(isPending(assetJobFor(viewApp))&&assetJobFor(viewApp)?.kind==='uninstall')?version=>{void localInstall({...viewApp,version});}:undefined}
                installStatus={viewApp?jobFor(viewApp):undefined} installBusy={!!localBusy||!!installing} installUnavailableReason={viewApp?installationUnavailableReason(viewApp):undefined}/>

            <InstallPlanModal plan={localPlans.review?.plan ?? null} name={localPlans.review?.app.name}
                projectName={targetProject?.name} canApprove={canManage} busy={!!localBusy}
                installOnApprove={!!localPlans.review?.installOnApprove}
                installDisabled={localPlans.installDisabled} installBlocker={localPlans.installBlocker} onInstall={() => { void localPlans.installReviewed(); }}
                onCancel={localPlans.cancel} onApprove={() => { void localPlans.approve(); }} onRevoke={() => { void localPlans.revoke(); }} />
            <InstallPlanFailureModal failure={localPlans.failure} busy={!!localBusy}
                onCancel={localPlans.cancel} onRetry={() => { void localPlans.retryFailure(); }}
                onOpenPackage={localPlans.failure ? () => {
                    const failed = localPlans.failure!.issue.package;
                    const app = catalog.find(item => item.id === failed.id && item.kind === failed.kind)
                        ?? { ...failed, description: '', tags: [], origin: '' };
                    localPlans.cancel(); setViewApp(app);
                } : undefined}
                onPackage={isMain ? () => { localPlans.cancel(); setViewApp(null); setPackagingOpen(true); } : undefined} />

            <StoreEditModal key={'edit:' + accessKey} editApp={editApp} onClose={() => setEditApp(null)} onSaved={loadCatalog} />
        </div>
    );
};

export default Store;
