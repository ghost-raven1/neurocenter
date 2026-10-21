import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { Alert, Button, Checkbox, Progress, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useBridge } from '../McpBridge/useBridge';
import { useLocalJob } from '../McpBridge/useLocalJob';
import { isPending } from '../McpBridge/installationHelpers';
import { projectBindingUrl, projectRagCatalogUrl } from '../../modules/Projects/projectNavigation';
import { embeddingConnected, embeddingConnectionBlocker, embeddingConnectionInput, embeddingInstallations, pendingEmbeddingAction, type IEmbeddingConnectionInput } from './connection';
import { sha, type IProjectEmbedding } from './model';
import { uuid } from '../McpBridge/operationHelpers';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { embeddingInstallationKey, useEmbeddingInstallation } from './useEmbeddingInstallation';
import { ragUiAnchorId, ragUiPreferenceKey, type IRagUiPreference } from '../McpBridge/ragUi/ragUiPreference';

/** Подключение требует отдельного согласия; получение настроек никогда не запускает локальную операцию. */
export function ProjectEmbeddingConnection({ selection, disabled, onPreferRagUi }: { selection: IProjectEmbedding; disabled: boolean; onPreferRagUi?:(value:IRagUiPreference)=>void }): JSX.Element {
    const bridge = useBridge();
    const { scope: owner } = useAuthRequestOwner();
    const device = bridge.device;
    const binding = device?.report.bindings?.find(item => item.projectId === selection.projectId && item.valid !== false);
    const choices = embeddingInstallations(bridge.installations, device, selection.projectId, bridge.jobs);
    const legacyConnections = choices.length > 1 && !device?.report.capabilities?.includes('hosted-rag-grants-v1');
    const scope = JSON.stringify([owner, selection.projectId, device?.id, device?.report.root, binding?.bindingId, binding?.instanceId, binding?.folderName]);
    const ready = bridge.devicesReady && bridge.jobsReady && bridge.installationsReady;
    const { item, eligible, choose } = useEmbeddingInstallation(scope, choices, ready);
    const installationPrompt = choices.length > 1 ? 'Выберите установку OpenCodeRAG для подключения модели.'
        : 'Установите или обновите OpenCodeRAG и проверьте его файлы в каталоге. Если установок несколько, выберите нужную.';
    const reason = !ready ? 'Дождитесь актуальных данных моста или обновите подключение.'
        : embeddingConnectionBlocker(device, binding) || (!item ? installationPrompt : !item.hostedEmbedding?.reindexSupported?'Обновите выбранный OpenCodeRAG для подключения с переиндексацией.':!eligible ? 'Выбранная установка OpenCodeRAG сейчас недоступна для подключения. Проверьте её файлы или выберите другую установку.' : '');
    const input = item && binding && sha(binding.bindingId) && uuid(binding.instanceId) && selection.profile && selection.modelPin ? embeddingConnectionInput(item, binding, selection) : undefined;
    const target = JSON.stringify([scope, item && embeddingInstallationKey(item), selection.revision, selection.modelPin]);
    const installationOptions: Array<{value: string; label: string; disabled?: boolean}> = choices.map(row => ({value: embeddingInstallationKey(row), label: installationLabel(row)}));
    if (item && !eligible) installationOptions.unshift({value: embeddingInstallationKey(item), label: `${installationLabel(item)} · недоступна`, disabled: true});
    return <Space direction="vertical" className="project-embedding__connection" size={12}>
        <Typography.Text strong>Подключение к OpenCodeRAG на компьютере</Typography.Text>
        <Select aria-label="Компьютер для подключения модели" placeholder="Выберите компьютер" value={device?.id} showSearch optionFilterProp="label"
            disabled={disabled} onChange={bridge.choose} options={bridge.devices.map(row => ({value: row.id, label: row.name}))} />
        {(choices.length > 1 || item && !eligible) && <Select aria-label="Установка OpenCodeRAG для модели" placeholder="Выберите установку OpenCodeRAG" value={item && embeddingInstallationKey(item)} disabled={disabled || !ready}
            onChange={choose} options={installationOptions} />}
        {item && <Typography.Text type="secondary">Установка: {installationLabel(item)}.</Typography.Text>}
        {device && <Typography.Text type="secondary">Компьютер: {device.name}. Общая папка: <Typography.Text code>{device.report.root || 'не выбрана'}</Typography.Text>. Папка проекта: <Typography.Text code>{binding?.folderName || 'не связана'}</Typography.Text>.</Typography.Text>}
        {reason && <Alert type="warning" showIcon message={reason} />}
        {legacyConnections && <Alert type="info" showIcon message="Этот мост поддерживает только одно подключение модели OpenCodeRAG."
            description="Для совместной работы MCP и плагина обновите мост и оба пакета OpenCodeRAG из каталога."
            action={<Button href="/start">Обновить мост</Button>} />}
        {bridge.error && <Alert type="warning" showIcon message={bridge.error} />}
        <Space wrap><Button loading={bridge.loading} onClick={() => { void bridge.reload(); }}>Обновить подключение</Button>
            {reason.includes('Обновите мост') && <Button href="/start">Обновить мост</Button>}
            {reason.includes('общую папку') && <Button href="/projects">Выбрать общую папку</Button>}
            {reason.includes('Свяжите') && <Button href={projectBindingUrl(selection.projectId)}>Связать папку</Button>}
            {(reason.includes('Установите или обновите') || item && !eligible) && <Button href={projectRagCatalogUrl(selection.projectId)}>Открыть OpenCodeRAG в каталоге</Button>}</Space>
        {input && item && device && binding && <ConnectEmbeddingAction key={target} input={input} selection={selection} bridge={bridge} disabled={disabled || !!reason} onPreferRagUi={onPreferRagUi}
            consent={`Подключить «${selection.model?.name}» (${selection.model?.model}) через ${installationLabel(item)} на компьютере «${device.name}», папка ${device.report.root || ''}/${binding.folderName}. Локальный индекс будет полностью перестроен, код и тексты отправятся провайдеру модели через Нейроцентр. Прежняя копия сохранится до проверки новой.`} />}
    </Space>;
}
const installationLabel = (row: {name: string; assetKind: string; version: number}): string => `${row.name} · ${row.assetKind === 'mcp' ? 'MCP' : 'плагин'} · версия ${row.version}`;

export function ConnectEmbeddingAction({input,selection,bridge,disabled,consent,onPreferRagUi}: {
    input: IEmbeddingConnectionInput; selection: IProjectEmbedding; bridge: ReturnType<typeof useBridge>; disabled: boolean; consent: string; onPreferRagUi?:(value:IRagUiPreference)=>void;
}): JSX.Element {
    const { scope:owner, captureOwner } = useAuthRequestOwner();
    const operation = useLocalJob(bridge);
    const [confirmed, setConfirmed] = useState(false);
    const pending = pendingEmbeddingAction(bridge.jobs, input.deviceId, input.projectId, input.expectedBindingId);
    const retrying = operation.canRetry(input);
    const job = operation.job||(!retrying&&bridge.jobsReady?bridge.jobs.find(candidate=>candidate.kind==='connect-rag-model'&&candidate.deviceId===input.deviceId&&candidate.projectId===input.projectId
        &&candidate.assetId===input.assetId&&candidate.assetKind===input.assetKind&&Number(candidate.version)===input.version&&candidate.expectedManifest===input.expectedManifest
        &&candidate.bindingId===input.expectedBindingId&&candidate.expectedInstanceId===input.expectedInstanceId&&embeddingConnected(candidate,selection)):undefined);
    const success = embeddingConnected(job, selection);
    const blocked = disabled || operation.busy || isPending(job) || pending;
    const binding=bridge.device?.report.bindings?.find(item=>item.projectId===input.projectId&&item.valid!==false);
    const preference:IRagUiPreference={owner,root:bridge.device?.report.root||'',request:{kind:'open-rag-ui',deviceId:input.deviceId,projectId:input.projectId,
        assetKind:input.assetKind,assetId:input.assetId,version:input.version,expectedManifest:input.expectedManifest,
        expectedBindingId:input.expectedBindingId,expectedInstanceId:input.expectedInstanceId}};
    const preferenceKey=ragUiPreferenceKey(preference);
    const currentTarget=bridge.device?.id===input.deviceId&&!!preference.root&&binding?.bindingId===input.expectedBindingId&&binding.instanceId===input.expectedInstanceId;
    useEffect(()=>{
        if(success&&!disabled&&currentTarget&&captureOwner()())onPreferRagUi?.(preference);
    },[success,disabled,currentTarget,preferenceKey,onPreferRagUi,captureOwner]);
    return <Space direction="vertical" size={12}>
        {!success && <Checkbox checked={confirmed} disabled={blocked || retrying} onChange={event => setConfirmed(event.target.checked)}>{consent}</Checkbox>}
        <FeatureButton features={retrying ? [] : ['rag_sync','computer_connections','model_hosting']} type="primary" loading={operation.busy || isPending(job)} disabled={blocked || !confirmed || success}
            onClick={() => { if (captureOwner()() && !blocked && confirmed && !success) void operation.submit(input); }}>
            {retrying ? 'Проверить отправленное подключение' : 'Подключить модель к OpenCodeRAG'}
        </FeatureButton>
        {job && !success && <Alert role="status" showIcon type={job.state === 'failed' ? 'error' : 'info'} message={job.message}
            description={job.state === 'succeeded' ? 'Подключение не подтверждено для текущей модели. Обновите сведения и повторите проверку.' : undefined} />}
        {isPending(job) && <Progress percent={job?.percent} status="active" />}
        {pending && !isPending(job) && <Typography.Text type="secondary">Дождитесь завершения текущего действия с папкой. Если ответ был потерян, затем проверьте отправленное подключение.</Typography.Text>}
        {operation.error && <Alert role="alert" type="error" showIcon message={operation.error} />}
        {success && <Alert role="status" type="info" showIcon message="Подключение модели проверено"
            description="Локальный индекс перестроен и синхронизирован с сервером. Перезапустите OpenCode, чтобы открытая сессия использовала новое подключение." />}
        {success && <>
            <Typography.Paragraph type="secondary">Локальный поиск готов. Интерфейс выбранной установки показывает результаты индексирования и поиска.</Typography.Paragraph>
            <Button type="link" href={'#'+ragUiAnchorId(input.projectId)}>Перейти к интерфейсу установки</Button>
        </>}
    </Space>;
}
