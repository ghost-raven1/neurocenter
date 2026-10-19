import { ExportOutlined } from '@ant-design/icons';
import { Alert, Button, Progress, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import type { useBridge } from '../useBridge';
import { isPending } from '../installationHelpers';
import { latestRagUiJob, ragUiBlocker, ragUiInstallationKey, ragUiInstallations, ragUiOutcome, ragUiRequest } from './ragUiState';
import { useRagUiLauncher } from './useRagUiLauncher';
import './OpenCodeRagUi.less';

interface IProps { bridge: ReturnType<typeof useBridge>; projectId: string; canWrite: boolean; }

/** Окно открывает установленный мост на выбранном компьютере; сайт не получает локальный URL. */
export function OpenCodeRagUi({ bridge, projectId, canWrite }: IProps): JSX.Element {
    const [selected, setSelected] = useState('');
    const binding = bridge.device?.report.bindings?.find(item => item.projectId === projectId && item.valid !== false);
    const choices = ragUiInstallations(bridge.installations, bridge.device, projectId, binding?.bindingId);
    const installation = choices.length === 1 ? choices[0] : choices.find(item => ragUiInstallationKey(item) === selected);
    const target = JSON.stringify([bridge.device?.id, projectId, binding?.bindingId, binding?.instanceId,
        installation ? ragUiInstallationKey(installation) : null]);
    const operation = useRagUiLauncher(target, bridge);
    const reason = ragUiBlocker({ ...bridge, projectId, binding, installation, choiceCount: choices.length, canWrite });
    const job = latestRagUiJob(bridge.jobs, installation, binding?.instanceId, operation.submitted);
    const pending = isPending(job), outcome = job && ragUiOutcome(job);
    const percent = typeof job?.percent === 'number' && Number.isFinite(job.percent) ? Math.max(0, Math.min(100, job.percent)) : undefined;
    const open = (): void => {
        if (reason || operation.busy || pending || !installation || !binding) return;
        void operation.submit(ragUiRequest(installation, binding));
    };
    return <Space direction="vertical" size={12} className="rag-ui">
        <div><Typography.Text strong>Интерфейс OpenCodeRAG</Typography.Text>
            <Typography.Paragraph type="secondary" className="rag-ui__description">Откроется отдельное окно браузера на компьютере моста с базой знаний выбранной папки проекта.</Typography.Paragraph></div>
        {choices.length > 1 && <Select aria-label="Установка OpenCodeRAG для открытия" placeholder="Выберите установку OpenCodeRAG" value={installation ? ragUiInstallationKey(installation) : undefined}
            disabled={operation.busy || pending} onChange={setSelected} className="rag-ui__select"
            options={choices.map(item => ({ value: ragUiInstallationKey(item), label: `${item.name} · ${item.assetKind === 'mcp' ? 'MCP' : 'плагин'} · версия ${item.version}` }))} />}
        <Space wrap>
            <Button icon={<ExportOutlined />} disabled={!!reason || operation.busy || pending} loading={operation.busy || pending} onClick={open}>
                {operation.error ? 'Проверить и повторить открытие' : ['failed', 'cancelled'].includes(job?.state ?? '') ? 'Повторить открытие OpenCodeRAG' : 'Открыть OpenCodeRAG в отдельном окне'}
            </Button>
            {reason && !pending && <Typography.Text type="secondary" className="rag-ui__reason">{reason}</Typography.Text>}
        </Space>
        {reason.includes('Обновите мост') && <Button className="rag-ui__next" href="/start">Обновить мост</Button>}
        {reason.startsWith('Установите или обновите OpenCodeRAG') && <Button className="rag-ui__next" href={`/store?${new URLSearchParams({ p: projectId, q: 'OpenCodeRAG' })}`}>Установить или обновить OpenCodeRAG</Button>}
        {operation.busy && !pending && <Typography.Text role="status" aria-live="polite">Передаём запрос выбранному мосту…</Typography.Text>}
        {pending && <div role="status" aria-live="polite"><Typography.Text>{job?.message || 'Открываем локальный интерфейс…'}</Typography.Text>
            <Progress percent={percent} status="active" showInfo={percent !== undefined} /></div>}
        {job && !pending && <Alert showIcon type={outcome ? 'info' : job.state === 'failed' ? 'error' : 'warning'} role="status"
            message={outcome ? outcome.reused ? 'Окно OpenCodeRAG уже открыто на компьютере моста' : 'Интерфейс OpenCodeRAG открыт на компьютере моста' : job.state === 'failed' ? 'Не удалось открыть интерфейс OpenCodeRAG' : job.state === 'cancelled' ? 'Открытие OpenCodeRAG отменено' : 'Открытие окна не подтверждено'}
            description={outcome?.note || (['failed', 'cancelled'].includes(job.state) ? job.message : 'Обновите данные моста и повторите открытие.')} />}
        {operation.error && <Alert role="alert" showIcon type="error" message={operation.error} action={<Button loading={bridge.loading} onClick={() => { void bridge.reload(); }}>Обновить данные</Button>} />}
    </Space>;
}
