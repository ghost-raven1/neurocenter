import { Alert, Button, Modal, Space, Tag, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { IBridgeInstallation } from './api';
import type { useBridge } from './useBridge';
import { useLocalJob } from './useLocalJob';
import { installedTuple } from './operationHelpers';
import { isPending, removalSelection } from './installationHelpers';
import { configurationBlocker, latestConfigurationStatus, matchingConfigurationOpened, matchingConfigurationPreparation } from './mcpConfiguration';
import type { IMcpConfigurationPreparation } from './mcpConfigurationTypes';
import './localOperations.less';

/** Площадка открывает локальный мастер и читает готовность; формы с секретами в этом окне нет. */
export function McpConfigurationModal({item,bridge,canManage,canView,onClose}: {
    item: IBridgeInstallation; bridge: ReturnType<typeof useBridge>; canManage: boolean; canView: boolean; onClose(): void;
}) {
    const operation = useLocalJob(bridge);
    const [preparingJob,setPreparingJob] = useState<string>();
    const [preparation,setPreparation] = useState<IMcpConfigurationPreparation>();
    const [openedJob,setOpenedJob] = useState<string>();
    const [opening,setOpening] = useState(false);
    const consumed = useRef(new Set<string>());
    const active = useRef(true);
    const instanceId = bridge.device?.report.bindings?.find(binding => binding.projectId === item.projectId && binding.bindingId === item.bindingId)?.instanceId;
    const scope = JSON.stringify([bridge.device?.id,item.deviceId,item.projectId,item.bindingId,instanceId,item.assetId,item.version,item.manifest,item.configurationSchemaDigest]);
    const initialScope = useRef(scope);
    const stale = scope !== initialScope.current;
    const ready = !!(bridge.devicesReady && bridge.jobsReady && bridge.installationsReady);
    const prepareJob = bridge.jobs.find(job => job.id === preparingJob) || (operation.job?.id === preparingJob ? operation.job : undefined);
    const openJob = bridge.jobs.find(job => job.id === openedJob) || (operation.job?.id === openedJob ? operation.job : undefined);
    const status = latestConfigurationStatus(removalSelection(item,bridge.installations,bridge.device) || item,bridge.jobs,instanceId);
    const opened = openJob?.state === 'succeeded' && matchingConfigurationOpened(openJob.result,item,preparation?.preparationId,instanceId);
    const needsRefresh = !!opened && (!status || Date.parse(status.checkedAt) <= Date.parse(openJob!.updatedAt));
    const excluded = operation.job?.id;
    const readReason = stale ? 'Компьютер или экземпляр папки изменился. Закройте окно и выберите текущую установку.'
        : configurationBlocker(item,bridge.installations,bridge.device,bridge.jobs,ready,canView,false,excluded);
    const writeReason = stale ? readReason : configurationBlocker(item,bridge.installations,bridge.device,bridge.jobs,ready,canManage,true,excluded);
    const locked = operation.busy || isPending(operation.job) || opening;
    const latest = useRef({bridge,canManage,canView,scope}); latest.current = {bridge,canManage,canView,scope};
    useEffect(() => { active.current = true; return () => { active.current = false; }; },[]);

    useEffect(() => {
        if (operation.busy || !prepareJob || !['succeeded','failed','cancelled'].includes(prepareJob.state) || consumed.current.has(prepareJob.id)) { return; }
        consumed.current.add(prepareJob.id);
        if (prepareJob.state !== 'succeeded') { setOpening(false); return; }
        const next = matchingConfigurationPreparation(prepareJob.result,item,instanceId);
        const live = latest.current;
        const reason = live.scope !== initialScope.current ? 'Папка изменилась. Откройте настройку текущей установки.'
            : configurationBlocker(item,live.bridge.installations,live.bridge.device,live.bridge.jobs,
                !!(live.bridge.devicesReady && live.bridge.jobsReady && live.bridge.installationsReady),live.canManage,true,prepareJob.id);
        if (!next || reason) { operation.setError(reason || 'Подготовка настройки устарела или относится к другой установке. Откройте мастер заново.'); setOpening(false); return; }
        setPreparation(next);
        void operation.submit({kind:'open-mcp-configuration',...installedTuple(item),assetKind:'mcp',version:item.version,
            configurationPreparationJobId:prepareJob.id,expectedConfigurationSchemaDigest:next.schemaDigest}).then(job => {
            if (active.current && live.scope === latest.current.scope) { setOpenedJob(job?.id); setOpening(false); }
        });
    },[prepareJob?.id,prepareJob?.state,operation.busy]);

    const open = async () => {
        if (locked || writeReason) { return; }
        setPreparation(undefined); setOpenedJob(undefined); setOpening(true);
        const job = await operation.submit({kind:'prepare-mcp-configuration',...installedTuple(item),assetKind:'mcp',version:item.version});
        if (active.current) { setPreparingJob(job?.id); if (!job) { setOpening(false); } }
    };
    const refresh = async () => {
        if (locked || readReason) { return; }
        await operation.submit({kind:'get-mcp-configuration-status',...installedTuple(item),assetKind:'mcp',version:item.version});
    };
    return <Modal open title={`Локальная настройка: «${item.name}»`} footer={null} width={640}
        onCancel={() => { if (!operation.busy) { onClose(); } }}>
        <Space direction="vertical" size={16} className="local-operation">
            <Typography.Text>Компьютер: <strong>{bridge.device?.name || 'Выбранный компьютер'}</strong> · версия {item.version}</Typography.Text>
            <Typography.Text>Папка: <strong>{item.folderName || 'Выбранная папка проекта'}</strong></Typography.Text>
            <Alert type="info" showIcon message="Введите параметры на выбранном компьютере"
                description="Мост откроет отдельное локальное окно браузера на этом компьютере. Ключи и другие значения сохраняются только там; площадка получает только готовность настройки." />
            <Space direction="vertical" size={4}>
                <Tag color={status?.ready ? 'blue' : 'gold'}>{!status ? 'Настройка ещё не проверена' : status.ready ? 'Параметры настроены локально' : 'Требуется настройка'}</Tag>
                {status && <Typography.Text type="secondary">Последняя проверка: {new Date(status.checkedAt).toLocaleString('ru-RU')}</Typography.Text>}
                {!!status?.missingFieldIds.length && <Typography.Text type="secondary">Осталось обязательных параметров: {status.missingFieldIds.length}. Их названия и подсказки показаны в локальном мастере.</Typography.Text>}
                {needsRefresh && <Typography.Text type="secondary">После сохранения параметров в мастере проверьте готовность заново.</Typography.Text>}
                <Typography.Text type="secondary">Наличие параметров не подтверждает доступ к сервису. После настройки отдельно проверьте файлы и запустите диагностику OpenCode.</Typography.Text>
            </Space>
            {opened && <Alert role="status" type="success" showIcon message="Локальный мастер открыт"
                description={`Завершите настройку на компьютере «${bridge.device?.name}», затем нажмите «Проверить готовность настройки». Ссылка действует до ${new Date(opened.expiresAt).toLocaleTimeString('ru-RU')}.`} />}
            {operation.job && !opened && <Alert role="status" type={operation.job.state === 'failed' ? 'warning' : 'info'} showIcon message={operation.job.message} />}
            <Space wrap>
                {canManage && <Button type="primary" loading={opening || operation.busy && operation.job?.kind !== 'get-mcp-configuration-status'} disabled={locked || !!writeReason}
                    onClick={() => { void open(); }}>{status?.ready ? 'Изменить локальную настройку' : 'Открыть настройку на компьютере'}</Button>}
                <Button disabled={locked || !!readReason} loading={operation.busy && operation.job?.kind === 'get-mcp-configuration-status'} onClick={() => { void refresh(); }}>Проверить готовность настройки</Button>
            </Space>
            {(writeReason && canManage || readReason) && <Alert type="warning" showIcon message={readReason || writeReason} />}
            {operation.error && <Alert role="alert" type="error" showIcon message={operation.error} />}
        </Space>
    </Modal>;
}
