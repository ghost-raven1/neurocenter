import { Alert, Button, Checkbox, List, Modal, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { bridgeApi, type IBridgeInstallation } from './api';
import type { IInstallPlan } from './installPlanTypes';
import type { useBridge } from './useBridge';
import { useLocalJob } from './useLocalJob';
import { installedTuple, latestInstallationReport, localActionBlocker, runtimeConsent, runtimeFileBlocker } from './operationHelpers';
import { removalSelection, isPending } from './installationHelpers';
import { RuntimeProbeStatus } from './RuntimeProbeStatus';
import { runtimeConfiguration } from './runtimeConfiguration';
import { errorMessage } from '../../common/utils/errorMessage';
import './localOperations.less';

/** Согласие относится к одобренному SHA всего комплекта, включая каждую закреплённую зависимость. */
export function RuntimeProbeModal({item,bridge,canManage,onClose}: {item:IBridgeInstallation;bridge:ReturnType<typeof useBridge>;canManage:boolean;onClose():void}) {
    const [plan,setPlan] = useState<IInstallPlan>(); const [preparing,setPreparing] = useState(true); const [confirmed,setConfirmed] = useState(false);
    const [approvalAttempt,setApprovalAttempt] = useState(0);
    const consentLock = useRef(false); const [checking,setChecking] = useState(false);
    const operation = useLocalJob(bridge);
    const latest = useRef({bridge,canManage}); latest.current = {bridge,canManage};
    const current = removalSelection(item,bridge.installations,bridge.device);
    const report = latestInstallationReport(current || item,bridge.jobs);
    const configuration = plan ? runtimeConfiguration(plan,item,bridge.installations.map(row => latestInstallationReport(row,bridge.jobs))) : {revisions:[],blocker:''};
    const configurationKey = JSON.stringify(configuration.revisions);
    const activeBinding = bridge.device?.report.bindings?.find(binding => binding.projectId === item.projectId && binding.bindingId === item.bindingId);
    const consentContext = JSON.stringify([canManage,bridge.device?.id,bridge.device?.role,bridge.device?.requiresReconnect,
        activeBinding?.instanceId,activeBinding?.valid,current?.manifest,current?.version]);
    const reason = localActionBlocker(item,bridge.installations,bridge.device,bridge.jobs,
        !!(bridge.devicesReady && bridge.jobsReady && bridge.installationsReady),canManage,'runtime-probe-v1',operation.job?.id) || runtimeFileBlocker(report) || configuration.blocker;
    useEffect(() => { setConfirmed(false); },[configurationKey,configuration.blocker,consentContext]);
    useEffect(() => {
        let cancelled = false;
        setPreparing(true); operation.setError('');
        bridgeApi.preparePlan({projectId:item.projectId,assetId:item.assetId,assetKind:item.assetKind,version:item.version}).then(value => {
            runtimeConsent(value,item); if (!cancelled) { setPlan(value); }
        }).catch(cause => { if (!cancelled) { operation.setError(errorMessage(cause,'Не удалось получить одобрение точной установленной версии.')); } })
            .finally(() => { if (!cancelled) { setPreparing(false); } });
        return () => { cancelled = true; };
    },[approvalAttempt]);
    const run = async () => {
        if (!plan || !confirmed || consentLock.current || operation.busy || isPending(operation.job)) { return; }
        consentLock.current = true; setChecking(true); operation.setError('');
        try {
            const approved = await bridgeApi.plan(plan.id);
            const consentManifest = runtimeConsent(approved,item);
            if (approved.revision !== plan.revision || consentManifest !== plan.manifest) { throw new Error('Одобрение изменилось. Закройте окно и подтвердите актуальный комплект.'); }
            const live = latest.current;
            const liveRow = removalSelection(item,live.bridge.installations,live.bridge.device);
            const liveConfiguration = runtimeConfiguration(approved,item,live.bridge.installations.map(row => latestInstallationReport(row,live.bridge.jobs)));
            const blocked = localActionBlocker(item,live.bridge.installations,live.bridge.device,live.bridge.jobs,
                !!(live.bridge.devicesReady && live.bridge.jobsReady && live.bridge.installationsReady),live.canManage,'runtime-probe-v1',operation.job?.id)
                || runtimeFileBlocker(latestInstallationReport(liveRow || item,live.bridge.jobs)) || liveConfiguration.blocker;
            if (blocked) { throw new Error(blocked); }
            if (JSON.stringify(liveConfiguration.revisions) !== configurationKey) { setConfirmed(false); throw new Error('Локальная настройка изменилась. Подтвердите диагностику для актуальных параметров.'); }
            await operation.submit({kind:'probe-runtime',...installedTuple(item),consentManifest,
                ...(liveConfiguration.revisions.length ? {expectedConfigurationRevisions:liveConfiguration.revisions} : {})});
        } catch (cause) { operation.setError(errorMessage(cause,'Не удалось подготовить диагностику.')); }
        finally { consentLock.current = false; setChecking(false); }
    };
    const locked = preparing || checking || operation.busy || isPending(operation.job);
    return <Modal open title={`Диагностика OpenCode: «${item.name}»`} footer={null} width={720} onCancel={() => { if (!checking && !operation.busy) { onClose(); } }}>
        <Space direction="vertical" size={16} className="local-operation">
            <Typography.Text>Папка: <strong>{item.folderName || 'Выбранная папка проекта'}</strong> · версия {item.version}</Typography.Text>
            <Alert type="warning" showIcon message="Диагностика выполняет одобренный код на вашем компьютере"
                description="MCP проходит подключение и чтение списков инструментов, ресурсов и промптов. Плагины проходят инициализацию и могут обращаться к настроенным сервисам, включая провайдер эмбеддингов. У скиллов проверяется структура без запуска скриптов. Диагностика не устанавливает npm-пакеты и не начинает OAuth." />
            {plan && <>
                <Typography.Text strong>Точный одобренный комплект</Typography.Text>
                <Typography.Text code className="local-operation__hash">SHA: {plan.manifest}</Typography.Text>
                {plan.packages?.length ? <List size="small" dataSource={plan.packages} rowKey={value => value.kind+':'+value.id} renderItem={value => <List.Item>
                    <Space direction="vertical" size={2}><Typography.Text>{value.name} · {value.kind} · версия {value.version}</Typography.Text>
                        <Typography.Text type="secondary" className="local-operation__hash">{value.manifest}</Typography.Text></Space>
                </List.Item>} /> : <Typography.Text>{item.name} · {item.assetKind} · версия {item.version}</Typography.Text>}
                <Checkbox checked={confirmed} disabled={locked || !!reason} onChange={event => setConfirmed(event.target.checked)}>
                    Разрешаю ограниченный запуск этого точного одобренного комплекта и его зависимостей
                </Checkbox>
            </>}
            {reason && <Alert type="info" showIcon message={reason} />}
            {configuration.revisions.length > 0 && <Typography.Text type="secondary">Проверка использует текущие локальные настройки MCP ({configuration.revisions.length}). Их изменение потребует новой диагностики.</Typography.Text>}
            {!plan && !preparing && <Button onClick={() => setApprovalAttempt(value => value + 1)}>Повторить загрузку одобрения</Button>}
            <Button type="primary" disabled={!plan || !confirmed || !!reason || locked} loading={locked} onClick={() => { void run(); }}>Запустить диагностику</Button>
            {operation.job && <Alert role="status" showIcon type={operation.job.state === 'failed' ? 'warning' : 'info'} message={operation.job.message} />}
            <RuntimeProbeStatus item={report} />
            {operation.error && <Alert role="alert" type="error" showIcon message={operation.error} />}
        </Space>
    </Modal>;
}
