import { Alert, Button, Checkbox, Progress, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import { useBridge } from '../McpBridge/useBridge';
import { useLocalJob } from '../McpBridge/useLocalJob';
import { isPending } from '../McpBridge/installationHelpers';
import { projectBindingUrl, projectRagCatalogUrl } from '../../modules/Projects/projectNavigation';
import { embeddingConnected, embeddingConnectionBlocker, embeddingConnectionInput, embeddingInstallations, pendingEmbeddingAction, type IEmbeddingConnectionInput } from './connection';
import { sha, type IProjectEmbedding } from './model';
import { uuid } from '../McpBridge/operationHelpers';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';

/** Подключение требует отдельного согласия; получение настроек никогда не запускает локальную операцию. */
export function ProjectEmbeddingConnection({ selection, disabled }: { selection: IProjectEmbedding; disabled: boolean }): JSX.Element {
    const bridge = useBridge();
    const [selected, setSelected] = useState('');
    const device = bridge.device;
    const binding = device?.report.bindings?.find(item => item.projectId === selection.projectId && item.valid !== false);
    const choices = embeddingInstallations(bridge.installations, device, selection.projectId, bridge.jobs);
    const item = choices.length === 1 ? choices[0] : choices.find(row => installationKey(row) === selected);
    const reason = !bridge.devicesReady || !bridge.jobsReady || !bridge.installationsReady ? 'Дождитесь актуальных данных моста или обновите подключение.'
        : embeddingConnectionBlocker(device, binding) || (!item ? 'Установите или обновите OpenCodeRAG и проверьте его файлы в каталоге. Если установок несколько, выберите нужную.' : '');
    const input = item && binding && sha(binding.bindingId) && uuid(binding.instanceId) && selection.profile && selection.modelPin ? embeddingConnectionInput(item, binding, selection) : undefined;
    const target = JSON.stringify([device?.id, device?.report.root, binding?.bindingId, binding?.instanceId, binding?.folderName, item && installationKey(item), selection.revision, selection.modelPin]);
    return <Space direction="vertical" className="project-embedding__connection" size={12}>
        <Typography.Text strong>Подключение к OpenCodeRAG на компьютере</Typography.Text>
        <Select aria-label="Компьютер для подключения модели" placeholder="Выберите компьютер" value={device?.id} showSearch optionFilterProp="label"
            disabled={disabled} onChange={bridge.choose} options={bridge.devices.map(row => ({value: row.id, label: row.name}))} />
        {choices.length > 1 && <Select aria-label="Установка OpenCodeRAG для модели" placeholder="Выберите установку OpenCodeRAG" value={item && installationKey(item)} disabled={disabled}
            onChange={setSelected} options={choices.map(row => ({value: installationKey(row), label: `${row.name} · ${row.assetKind === 'mcp' ? 'MCP' : 'плагин'} · версия ${row.version}`}))} />}
        {device && <Typography.Text type="secondary">Компьютер: {device.name}. Общая папка: <Typography.Text code>{device.report.root || 'не выбрана'}</Typography.Text>. Папка проекта: <Typography.Text code>{binding?.folderName || 'не связана'}</Typography.Text>.</Typography.Text>}
        {reason && <Alert type="warning" showIcon message={reason} />}
        {bridge.error && <Alert type="warning" showIcon message={bridge.error} />}
        <Space wrap><Button loading={bridge.loading} onClick={() => { void bridge.reload(); }}>Обновить подключение</Button>
            {reason.includes('Обновите мост') && <Button href="/start">Обновить мост</Button>}
            {reason.includes('общую папку') && <Button href="/projects">Выбрать общую папку</Button>}
            {reason.includes('Свяжите') && <Button href={projectBindingUrl(selection.projectId)}>Связать папку</Button>}
            {reason.includes('Установите или обновите') && <Button href={projectRagCatalogUrl(selection.projectId)}>Открыть OpenCodeRAG в каталоге</Button>}</Space>
        {input && device && binding && <ConnectEmbeddingAction key={target} input={input} selection={selection} bridge={bridge} disabled={disabled || !!reason}
            consent={`Подключить «${selection.model?.name}» (${selection.model?.model}) на компьютере «${device.name}», папка ${device.report.root || ''}/${binding.folderName}. Код и тексты для эмбеддингов будут отправляться на сервер Нейроцентра.`} />}
    </Space>;
}
const installationKey = (row: {assetKind: string; assetId: string; version: number; manifest: string}) => JSON.stringify([row.assetKind, row.assetId, row.version, row.manifest]);

export function ConnectEmbeddingAction({input,selection,bridge,disabled,consent}: {
    input: IEmbeddingConnectionInput; selection: IProjectEmbedding; bridge: ReturnType<typeof useBridge>; disabled: boolean; consent: string;
}): JSX.Element {
    const { captureOwner } = useAuthRequestOwner();
    const operation = useLocalJob(bridge);
    const [confirmed, setConfirmed] = useState(false);
    const pending = pendingEmbeddingAction(bridge.jobs, input.deviceId, input.projectId, input.expectedBindingId);
    const retrying = operation.canRetry(input);
    const job = operation.job;
    const success = embeddingConnected(job, selection);
    const blocked = disabled || operation.busy || isPending(job) || pending;
    return <Space direction="vertical" size={12}>
        {!success && <Checkbox checked={confirmed} disabled={blocked || retrying} onChange={event => setConfirmed(event.target.checked)}>{consent}</Checkbox>}
        <Button type="primary" loading={operation.busy || isPending(job)} disabled={blocked || !confirmed || success}
            onClick={() => { if (captureOwner()() && !blocked && confirmed && !success) void operation.submit(input); }}>
            {retrying ? 'Проверить отправленное подключение' : 'Подключить модель к OpenCodeRAG'}
        </Button>
        {job && !success && <Alert role="status" showIcon type={job.state === 'failed' ? 'error' : 'info'} message={job.message}
            description={job.state === 'succeeded' ? 'Подключение не подтверждено для текущей модели. Обновите сведения и повторите проверку.' : undefined} />}
        {isPending(job) && <Progress percent={job?.percent} status="active" />}
        {pending && !isPending(job) && <Typography.Text type="secondary">Дождитесь завершения текущего действия с папкой. Если ответ был потерян, затем проверьте отправленное подключение.</Typography.Text>}
        {operation.error && <Alert role="alert" type="error" showIcon message={operation.error} />}
        {success && <Alert role="status" type="info" showIcon message="Подключение модели проверено"
            description="Перезапустите OpenCode. Индекс не изменён и его готовность не подтверждена. Для серверной модели автоматическая индексация отключена: полную переиндексацию запускайте отдельно после проверки настроек и сохранения нужной копии." />}
    </Space>;
}
