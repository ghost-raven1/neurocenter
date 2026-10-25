import {PluginAutoUpdateControl} from '../PluginAutoUpdates/PluginAutoUpdateControl';
import { Alert, Button, Card, Collapse, List, Modal, Space, Tabs, Tag, Typography } from 'antd';
import { ApiOutlined, AppstoreOutlined, DownOutlined, FileTextOutlined } from '@ant-design/icons';
import { useEffect, useId, useRef, useState, type FC } from 'react';
import { bridgeApi, type IBridgeInstallation } from './api';
import { useBridge } from './useBridge';
import { hasCurrentBinding, installationIdentity, installationRequest, isPending, latestAssetJob, latestInspectionJob, removalSelection } from './installationHelpers';
import { inspectionBlocker, inspectionNotice, installationBlocker } from './readiness';
import { InstallationInspectionStatus } from './InstallationInspectionStatus';
import { InstallationOperationActions } from './InstallationOperationActions';
import { RuntimeProbeStatus } from './RuntimeProbeStatus';
import { latestInstallationReport, pendingLocalJob } from './operationHelpers';
import { ProjectInventory } from './ProjectInventory';
import { runtimeConfigurationChanged } from './runtimeConfiguration';
import { installationProgress } from './installationProgress';
import { errorMessage } from '../../common/utils/errorMessage';
import { createBridgeRequestKey } from './bridgeRequestKey';
import './LocalInstallations.less';

interface IProps {
    bridge: ReturnType<typeof useBridge>;
    projectId: string;
    canManage: boolean;
    canInspect?: boolean;
    connectionNoticeVisible?: boolean;
    catalog: Array<{ id: string; kind: string; name: string }>;
    approved: Set<string>;
}
interface IRemovalSelection extends IBridgeInstallation { deviceName: string; folderName: string; }
const kindLabels = { skill: 'Скилл', mcp: 'MCP', plugin: 'Плагин' };

/** История папок отделена от текущей установки; проверка файлов не требует прав удаления. */
export const LocalInstallations: FC<IProps> = ({bridge, projectId, canManage, canInspect = false, connectionNoticeVisible = false, catalog, approved}) => {
    const {device, jobs, installations} = bridge;
    const [selected, setSelected] = useState<IRemovalSelection>();
    const [removalError, setRemovalError] = useState('');
    const [removalBusy, setRemovalBusy] = useState(false);
    const [inspectionError, setInspectionError] = useState<{key: string; message: string}>();
    const [inspectionBusy, setInspectionBusy] = useState('');
    const [expanded, setExpanded] = useState(false);
    const contentId = useId();
    const removalLock = useRef(false);
    const inspectionLock = useRef(false);
    const removalKeys = useRef(new Map<string, string>());
    const inspectionKeys = useRef(new Map<string, string>());
    const active = useRef(true);
    const scope = JSON.stringify([device?.id, projectId]);
    const scopeRef = useRef(scope);
    scopeRef.current = scope;
    const latest = useRef({bridge, projectId, canManage, canInspect});
    latest.current = {bridge, projectId, canManage, canInspect};
    useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    if (!device || !bridge.installationsReady) { return null; }

    const items = installations.filter(item => item.deviceId === device.id && item.projectId === projectId);
    const currentItems = items.filter(item => hasCurrentBinding(item, device));
    const historyItems = items.filter(item => !hasCurrentBinding(item, device));
    const currentInspectionError = currentItems.some(item => installationIdentity(item) === inspectionError?.key) ? inspectionError : undefined;
    const nameFor = (item: IBridgeInstallation): string => catalog.find(app => app.id === item.assetId && app.kind === item.assetKind)?.name || item.name || 'Инструмент';
    const folderFor = (item: IBridgeInstallation): string => item.folderName || device.report.bindings?.find(binding =>
        binding.projectId === item.projectId && binding.bindingId === item.bindingId && !!item.bindingId)?.folderName
        || (item.bindingId ? `Прежняя привязка (${item.bindingId.slice(0, 8)})` : 'Папка неизвестна');
    const selectedCurrent = removalSelection(selected, items, device);
    const selectedJob = selected ? latestAssetJob(jobs, selected) : undefined;
    const removalBlocker = installationBlocker(device);
    const inspectBlocker = bridge.devicesReady ? inspectionBlocker(device) : '';
    const inspectNotice = bridge.devicesReady ? inspectionNotice(device, connectionNoticeVisible) : '';
    const latestRemoval = jobs.find(job => job.deviceId === device.id && job.projectId === projectId && job.kind === 'uninstall');
    const recoveryPath = typeof latestRemoval?.result?.recoveryPath === 'string' ? latestRemoval.result.recoveryPath : undefined;
    const removedName = catalog.find(app => app.id === latestRemoval?.assetId && app.kind === latestRemoval?.assetKind)?.name || latestRemoval?.assetId || 'Инструмент';

    const removal = async (): Promise<void> => {
        const current = latest.current;
        const row = removalSelection(selected, current.bridge.installations, current.bridge.device);
        if (!row || current.projectId !== row.projectId) { setRemovalError('Установка или папка изменилась. Закройте окно и выберите актуальную запись.'); return; }
        if (!current.canManage || !current.bridge.devicesReady || !current.bridge.jobsReady || !current.bridge.installationsReady
            || installationBlocker(current.bridge.device) || pendingLocalJob(current.bridge.jobs,row) || removalLock.current) { return; }
        removalLock.current = true; setRemovalBusy(true); setRemovalError('');
        const operationScope = scopeRef.current;
        try {
            const key = JSON.stringify([installationIdentity(row), row.version, row.manifest]);
            const requestKey = removalKeys.current.get(key) || createBridgeRequestKey();
            removalKeys.current.set(key, requestKey);
            await bridgeApi.create(installationRequest('uninstall', row, requestKey));
            removalKeys.current.delete(key);
            if (active.current && scopeRef.current === operationScope) { setSelected(undefined); await current.bridge.reload(); }
        } catch (cause) {
            if (active.current && scopeRef.current === operationScope) { setRemovalError(errorMessage(cause, 'Не удалось передать удаление мосту.')); }
        } finally {
            removalLock.current = false;
            if (active.current && scopeRef.current === operationScope) { setRemovalBusy(false); }
        }
    };

    const inspect = async (item: IBridgeInstallation): Promise<void> => {
        const current = latest.current;
        const row = removalSelection(item, current.bridge.installations, current.bridge.device);
        if (!row || row.projectId !== current.projectId || !current.canInspect || inspectionBlocker(current.bridge.device)
            || !current.bridge.devicesReady || !current.bridge.jobsReady || !current.bridge.installationsReady || inspectionLock.current
            || pendingLocalJob(current.bridge.jobs,row)) { return; }
        inspectionLock.current = true;
        const rowKey = installationIdentity(row);
        setInspectionBusy(rowKey); setInspectionError(undefined);
        const operationScope = scopeRef.current;
        try {
            const key = JSON.stringify([rowKey, row.version, row.manifest]);
            const requestKey = inspectionKeys.current.get(key) || createBridgeRequestKey();
            inspectionKeys.current.set(key, requestKey);
            await bridgeApi.create(installationRequest('inspect-installation', row, requestKey));
            inspectionKeys.current.delete(key);
            if (active.current && scopeRef.current === operationScope) { await current.bridge.reload(); }
        } catch (cause) {
            if (active.current && scopeRef.current === operationScope) { setInspectionError({key:rowKey,message:errorMessage(cause, 'Не удалось передать проверку файлов мосту.')}); }
        } finally {
            inspectionLock.current = false;
            if (active.current && scopeRef.current === operationScope) { setInspectionBusy(''); }
        }
    };

    const cancelInspection = async (id: string, key: string): Promise<void> => {
        try { await bridgeApi.cancel(id); await bridge.reload(); }
        catch (cause) { if (active.current) { setInspectionError({key,message:errorMessage(cause, 'Не удалось отменить проверку файлов.')}); } }
    };

    const renderInstallation = (item: IBridgeInstallation, historical = false) => {
        const key = installationIdentity(item);
        const pendingChange = pendingLocalJob(jobs,item);
        const reported = latestInstallationReport(item,jobs);
        const report = reported.runtime && runtimeConfigurationChanged(reported,installations.map(row => latestInstallationReport(row,jobs)))
            ? {...reported,runtime:{...reported.runtime,status:'stale' as const}} : reported;
        const inspectionJob = latestInspectionJob(jobs, item);
        const mutationPending = !!pendingChange;
        const inspecting = isPending(inspectionJob);
        const currentBinding = hasCurrentBinding(item, device);
        const next = installationProgress(report,jobs);
        const inspectReason = !currentBinding ? 'Проверка доступна только для текущей подтверждённой папки.' : inspectBlocker
            || (!bridge.devicesReady || !bridge.jobsReady ? 'Дождитесь загрузки подключения и очереди.' : mutationPending ? 'Дождитесь завершения изменения установки.' : '');
        const installedAt = new Date(item.updatedAt);
        return <List.Item><article className={`local-installations__item${historical ? ' local-installations__item--history' : ''}`} data-state={historical ? 'history' : next.state}>
            <div className="local-installations__header">
                <span className="local-installations__icon" aria-hidden="true">{item.assetKind === 'mcp' ? <ApiOutlined/> : item.assetKind === 'plugin' ? <AppstoreOutlined/> : <FileTextOutlined/>}</span>
                <div className="local-installations__identity">
                    <Typography.Text strong ellipsis={{tooltip:nameFor(item)}} className="local-installations__name">{nameFor(item)}</Typography.Text>
                    <Typography.Text type="secondary" className="local-installations__version">{kindLabels[item.assetKind]}<span aria-hidden="true"> · </span>Версия {item.version}</Typography.Text>
                </div>
            </div>
            <div className="local-installations__summary">
                {historical && <Typography.Text type="secondary" ellipsis={{tooltip:folderFor(item)}} className="local-installations__folder">{folderFor(item)}</Typography.Text>}
                {historical ? <Tag>{item.legacyBinding || !item.bindingId ? 'Привязка неизвестна' : 'Прежняя папка'}</Tag> : <>
                    <div className="local-installations__state" role={mutationPending || inspecting ? 'status' : undefined}><span className="local-installations__state-dot" aria-hidden="true"/>{next.title}</div>
                    <Typography.Text type="secondary" className="local-installations__next">{next.description}</Typography.Text>
                </>}
                {!approved.has(item.assetKind + ':' + item.assetId) && <Typography.Text type="secondary" className="local-installations__catalog-note">Убран из каталога проекта</Typography.Text>}
                {inspecting && !mutationPending && <Typography.Text role="status">Проверка файлов: {inspectionJob?.message}</Typography.Text>}
                {inspectionJob?.state === 'failed' && <Typography.Text type="warning">Проверка не завершена: {inspectionJob.message}</Typography.Text>}
                {historical && inspectionError?.key === key && <Alert role="alert" type="error" showIcon message={inspectionError.message} />}
            </div>
            {!historical && item.assetKind === 'plugin' && <PluginAutoUpdateControl installation={item} canManage={canManage} onChanged={() => { void bridge.reload(); }} />}
            <details className="local-installations__details">
                <summary>Сверка и запуск<DownOutlined aria-hidden="true"/></summary>
                <div className="local-installations__details-content">
                    {historical && !item.inspection ? <Typography.Text type="secondary">Файлы не сверялись</Typography.Text> : <InstallationInspectionStatus item={report} showRuntimeHint={historical} />}
                    {!historical && <RuntimeProbeStatus item={report} />}
                    <Typography.Text type="secondary" className="local-installations__date">Обновлено {installedAt.toLocaleString('ru-RU')}</Typography.Text>
                </div>
            </details>
            {(!historical && (canInspect || canManage) || inspectionJob?.state === 'queued') && <Space wrap className="local-installations__actions">
                {!historical && canInspect && <Button size="small" type={next.action === 'inspect' ? 'primary' : 'default'} disabled={!!inspectReason || inspecting || !!inspectionBusy || removalBusy}
                    title={inspectReason || undefined} loading={inspectionBusy === key || inspecting}
                    onClick={() => { void inspect(item); }}>Проверить файлы</Button>}
                {inspectionJob?.state === 'queued' && <Button size="small" onClick={() => { void cancelInspection(inspectionJob.id, key); }}>Отменить проверку</Button>}
                {!historical && (canManage || canInspect) && <InstallationOperationActions item={{...report,folderName:folderFor(item)}} bridge={bridge} canManage={canManage} canView={canInspect} />}
                {!historical && canManage && <Button danger type="text" size="small" disabled={!currentBinding || !!removalBlocker || mutationPending || removalBusy || !bridge.devicesReady || !bridge.jobsReady}
                    title={removalBlocker || (!currentBinding ? 'Удаление доступно только в исходной текущей папке.' : undefined)}
                    onClick={() => { setRemovalError(''); setSelected({...item, deviceName:device.name, folderName:folderFor(item)}); }}>Удалить с компьютера</Button>}
            </Space>}
        </article></List.Item>;
    };
    const currentBinding = device.report.bindings?.find(binding => binding.projectId === projectId && binding.valid !== false);
    const currentFolder = currentBinding?.folderName;
    /** Старые папки и ошибки до более нового результата не превращаются в текущую проблему. */
    const currentJobs = jobs.filter(job => job.deviceId === device.id && job.projectId === projectId
        && !!currentBinding?.bindingId && job.bindingId === currentBinding.bindingId);
    const pendingJobs = currentJobs.filter(isPending);
    const failedJobs = currentJobs.filter((job, index) => job.assetId && job.state === 'failed'
        && !currentJobs.slice(0, index).some(previous => previous.assetId === job.assetId && previous.assetKind === job.assetKind));
    const attentionItems = currentItems.map(item => ({item, next:installationProgress(latestInstallationReport(item,jobs),jobs)}))
        .filter(({item, next}) => ['modified', 'help'].includes(next.state)
            && !failedJobs.some(job => job.assetId === item.assetId && job.assetKind === item.assetKind));
    const attentionCount = failedJobs.length + attentionItems.length + Number(!!currentInspectionError) + Number(!!removalError);
    const jobName = (job: typeof jobs[number]): string => catalog.find(app => app.id === job.assetId && app.kind === job.assetKind)?.name
        || items.find(item => item.assetId === job.assetId && item.assetKind === job.assetKind)?.name || job.assetId || 'Проект';

    return <Card className="local-installations" size="small" title={<Space wrap size={8}>
        <span>На этом компьютере</span><Tag>Установок: {currentItems.length}</Tag>
        {pendingJobs.length > 0 && <Tag color="processing">В работе: {pendingJobs.length}</Tag>}
        {attentionCount > 0 && <Tag color="warning">Требуют внимания: {attentionCount}</Tag>}
    </Space>} extra={<Button size="small" type="text" className="local-installations__toggle" aria-expanded={expanded} aria-controls={contentId}
        icon={<DownOutlined aria-hidden="true"/>} onClick={() => setExpanded(value => !value)}>{expanded ? 'Скрыть установки' : 'Показать установки'}</Button>}>
        <div className="local-installations__intro">
            <Typography.Text strong ellipsis={{tooltip:currentFolder || 'Папка не связана'}} className="local-installations__folder">{currentFolder ? `Текущая папка: ${currentFolder}` : 'Текущая папка проекта не связана'}</Typography.Text>
            {!expanded && items.length === 0 && <Typography.Text type="secondary">В этом проекте нет установленных через мост инструментов</Typography.Text>}
        </div>
        {!expanded && <div className="local-installations__attention">
            {pendingJobs.filter(job => job.id !== latestRemoval?.id).map(job => <Alert key={job.id} role="status" type="info" showIcon
                message={`${jobName(job)}: ${job.message}`} action={job.state === 'queued' ? <Button size="small" aria-label={`Отменить действие: ${jobName(job)}`} onClick={() => {
                    void bridgeApi.cancel(job.id).then(() => bridge.reload()).catch(cause => setRemovalError(errorMessage(cause, 'Не удалось отменить действие.')));
                }}>Отменить</Button> : undefined} />)}
            {failedJobs.filter(job => job.id !== latestRemoval?.id).map(job => <Alert key={job.id} role="alert" type="error" showIcon message={`${jobName(job)}: ${job.message}`} />)}
            {attentionItems.map(({item, next}) => <Alert key={installationIdentity(item)} type="warning" showIcon message={`${nameFor(item)}: ${next.title}`} />)}
        </div>}
        {currentInspectionError && <Alert role="alert" type="error" showIcon message={currentInspectionError.message} />}
        {latestRemoval && <Alert role="status" showIcon type={latestRemoval.state === 'failed' ? 'error' : latestRemoval.state === 'succeeded' ? 'success' : 'info'}
            message={`Удаление «${removedName}» · ${new Date(latestRemoval.updatedAt).toLocaleString('ru-RU')}`}
            description={<>
                <div>{latestRemoval.message}</div>
                <div>Привязка: {latestRemoval.bindingId?.slice(0,8) || 'неизвестна'}</div>
                {latestRemoval.state === 'succeeded' && recoveryPath && <><div>Резервная копия сохранена локально:</div><Typography.Text copyable code className="local-installations__path">{recoveryPath}</Typography.Text></>}
            </>}
            action={latestRemoval.state === 'queued' ? <Button size="small" onClick={() => {
                void bridgeApi.cancel(latestRemoval.id).then(() => bridge.reload()).catch(cause => setRemovalError(errorMessage(cause, 'Не удалось отменить удаление.')));
            }}>Отменить</Button> : undefined} />}
        {removalError && !selected && <Alert role="alert" type="error" showIcon message={removalError} />}
        <section id={contentId} className="local-installations__content" hidden={!expanded} aria-label="Установки и история">
            {items.length > 0 && <Typography.Text type="secondary">Сверка файлов и диагностика запуска выполняются отдельно.</Typography.Text>}
            <Tabs items={[{key:'managed',label:'Под управлением',children:<>
            {canInspect && inspectNotice && <Alert type="info" showIcon message={inspectNotice} />}
            {currentItems.length ? <List className="local-installations__grid" split={false} rowKey={installationIdentity} dataSource={currentItems} renderItem={item => renderInstallation(item)} />
                : items.length ? <Typography.Text type="secondary">В текущей папке нет установок.</Typography.Text>
                : <Typography.Text type="secondary" className="local-installations__empty">В этом проекте нет установленных через мост инструментов</Typography.Text>}
            {historyItems.length > 0 && <Collapse ghost className="local-installations__history">
                <Collapse.Panel key="previous-folders" header={`История других папок (${historyItems.length})`} forceRender>
                    <Typography.Paragraph type="secondary">Эти записи относятся к прежним или неизвестным папкам. Проверка и удаление доступны для текущей подтверждённой папки.</Typography.Paragraph>
                    <List size="small" rowKey={installationIdentity} dataSource={historyItems} renderItem={item => renderInstallation(item,true)} />
                </Collapse.Panel>
            </Collapse>}
            </>},{key:'discovered',label:'Найдено в проекте',children:<ProjectInventory bridge={bridge} projectId={projectId} canInspect={canInspect} canManage={canManage} catalog={catalog} />}]} />
        </section>
        <Modal open={!!selected} title={selected ? `Удалить «${nameFor(selected)}» с компьютера?` : ''}
            onCancel={() => { if (!removalLock.current) { setSelected(undefined); } }} onOk={() => { void removal(); }}
            okText="Удалить с компьютера" cancelText="Отмена"
            okButtonProps={{danger:true,loading:removalBusy,disabled:!selectedCurrent || !canManage || !!removalBlocker || !bridge.devicesReady || !bridge.jobsReady || isPending(selectedJob) || !!(selected && pendingLocalJob(jobs,selected))}}
            closable={!removalBusy} keyboard={!removalBusy} maskClosable={!removalBusy}>
            <Typography.Paragraph>Компьютер: <strong>{selected?.deviceName}</strong>. Папка проекта: <strong>{selected?.folderName}</strong>.</Typography.Paragraph>
            <Typography.Paragraph>Удалится версия {selected?.version} и её подключение OpenCode. Инструмент останется в каталоге команды. Изменённые вручную файлы остановят удаление; резервная копия сохранится локально.</Typography.Paragraph>
            {selected && !selectedCurrent && <Alert type="warning" showIcon message="Установка или привязка изменилась. Закройте окно и выберите актуальную запись." />}
            {bridge.devicesReady && !device.online && <Alert type="info" showIcon message="Мост не в сети. Задание дождётся его подключения." />}
            {removalError && <Alert role="alert" type="error" showIcon message={removalError} />}
        </Modal>
    </Card>;
};
