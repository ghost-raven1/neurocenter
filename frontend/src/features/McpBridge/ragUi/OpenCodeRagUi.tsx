import { ExportOutlined } from '@ant-design/icons';
import { Alert, Button, Progress, Select, Space, Typography } from 'antd';
import { useRef, useState } from 'react';
import type { useBridge } from '../hooks/useBridge';
import { isPending } from '../installationHelpers';
import {
    latestRagUiJob,
    ragUiBlocker,
    ragUiInstallationKey,
    ragUiInstallations,
    ragUiOutcome,
    ragUiRequest,
} from './ragUiState';
import { useRagUiLauncher } from './hooks/useRagUiLauncher';
import { useAuthRequestOwner } from '../../UserBlock/hooks/useAuthRequestOwner';
import {
    matchesRagUiPreference,
    ragUiAnchorId,
    ragUiPreferenceBlocker,
    ragUiPreferenceKey,
    type IRagUiPreference,
} from './ragUiPreference';
import { projectEmbeddingApi, type IProjectEmbeddingTarget } from '../../ProjectEmbedding/model';
import type { TRagUiInstallation } from './ragUiState';
import './OpenCodeRagUi.less';

interface IProps {
    bridge: ReturnType<typeof useBridge>;
    projectId: string;
    canWrite: boolean;
    preferred?: IRagUiPreference;
    persisted?: IProjectEmbeddingTarget | null;
}

/** Окно открывает установленный мост на выбранном компьютере; сайт не получает локальный URL. */
export function OpenCodeRagUi({ bridge, projectId, canWrite, preferred, persisted }: IProps): JSX.Element {
    const { scope: owner, captureOwner } = useAuthRequestOwner();
    const binding = bridge.device?.report.bindings?.find(
        (item) => item.projectId === projectId && item.valid !== false,
    );
    const choices = ragUiInstallations(bridge.installations, bridge.device, projectId, binding?.bindingId);
    const scope = JSON.stringify([
        owner,
        projectId,
        bridge.device?.id,
        bridge.device?.report.root,
        binding?.bindingId,
        binding?.instanceId,
        preferred && ragUiPreferenceKey(preferred),
    ]);
    const currentScope = useRef({ scope, epoch: 0 });
    if (currentScope.current.scope !== scope) currentScope.current = { scope, epoch: currentScope.current.epoch + 1 };
    const epoch = currentScope.current.epoch;
    const [selection, setSelection] = useState<{ scope: string; key: string }>({ scope, key: '' });
    if (selection.scope !== scope) setSelection({ scope, key: '' });
    const selected = selection.scope === scope ? selection.key : '';
    const usePreferred = !!preferred && !selected;
    const persistedInstallation = persisted?.mode === 'computer' ? persisted.installation : undefined;
    const matchesPersisted = (item: TRagUiInstallation): boolean =>
        !!persistedInstallation &&
        item.deviceId === persistedInstallation.deviceId &&
        item.assetKind === persistedInstallation.assetKind &&
        item.assetId === persistedInstallation.assetId &&
        item.version === persistedInstallation.version &&
        item.manifest === persistedInstallation.expectedManifest;
    const installation = selected
        ? choices.find((item) => ragUiInstallationKey(item) === selected)
        : preferred
          ? choices.find((item) => matchesRagUiPreference(item, preferred))
          : choices.find(matchesPersisted) || (choices.length === 1 ? choices[0] : undefined);
    const fromPersisted = !selected && !preferred && !!installation && matchesPersisted(installation);
    const preferenceReason = usePreferred
        ? ragUiPreferenceBlocker(preferred!, owner, projectId, bridge.device, binding)
        : '';
    const target = JSON.stringify([
        scope,
        selected || (preferred ? 'preferred' : installation ? ragUiInstallationKey(installation) : null),
    ]);
    const operation = useRagUiLauncher(target, bridge);
    const reason =
        preferenceReason ||
        ((usePreferred || selected) && !installation
            ? 'Выбранная установка OpenCodeRAG сейчас недоступна. Обновите данные или явно выберите другую установку.'
            : '') ||
        ragUiBlocker({ ...bridge, projectId, binding, installation, choiceCount: choices.length, canWrite });
    const job = latestRagUiJob(bridge.jobs, installation, binding?.instanceId, operation.submitted);
    const pending = isPending(job),
        outcome = job && ragUiOutcome(job);
    const percent =
        typeof job?.percent === 'number' && Number.isFinite(job.percent)
            ? Math.max(0, Math.min(100, job.percent))
            : undefined;
    const open = (): void => {
        if (
            !captureOwner()() ||
            currentScope.current.scope !== scope ||
            currentScope.current.epoch !== epoch ||
            reason ||
            operation.busy ||
            pending ||
            !installation ||
            !binding
        )
            return;
        void operation.submit(ragUiRequest(installation, binding));
    };
    const choose = (key: string): void => {
        if (
            !captureOwner()() ||
            currentScope.current.scope !== scope ||
            currentScope.current.epoch !== epoch ||
            !bridge.devicesReady ||
            !bridge.jobsReady ||
            !bridge.installationsReady ||
            !canWrite ||
            operation.busy ||
            pending
        )
            return;
        const item = choices.find((value) => ragUiInstallationKey(value) === key);
        if (!item) return;
        setSelection({ scope, key });
        // Селектор делит с подключением модели один персист проекта.
        void projectEmbeddingApi
            .saveTarget(projectId, {
                mode: 'computer',
                installation: {
                    deviceId: item.deviceId,
                    assetId: item.assetId,
                    assetKind: item.assetKind,
                    version: item.version,
                    expectedManifest: item.manifest,
                },
            })
            .catch(() => undefined);
    };
    return (
        <Space id={ragUiAnchorId(projectId)} direction="vertical" size={12} className="rag-ui">
            <div>
                <Typography.Text strong>Интерфейс OpenCodeRAG</Typography.Text>
                <Typography.Paragraph type="secondary" className="rag-ui__description">
                    Откроется отдельное окно браузера на компьютере моста с базой знаний выбранной папки проекта.
                </Typography.Paragraph>
            </div>
            {preferred && (
                <Typography.Text type="secondary">
                    После подключения модели: {preferred.request.assetKind === 'mcp' ? 'MCP' : 'плагин'} · версия{' '}
                    {preferred.request.version} · компьютер{' '}
                    {bridge.devices.find((item) => item.id === preferred.request.deviceId)?.name ||
                        preferred.request.deviceId}
                    .
                </Typography.Text>
            )}
            {fromPersisted && (
                <Typography.Text type="secondary">
                    Подключение модели проекта использует выбранную установку.
                </Typography.Text>
            )}
            {(choices.length > 1 || preferred || selected) && (
                <Select
                    aria-label="Установка OpenCodeRAG для открытия"
                    placeholder="Выберите установку OpenCodeRAG"
                    value={installation ? ragUiInstallationKey(installation) : undefined}
                    disabled={
                        operation.busy ||
                        pending ||
                        !canWrite ||
                        !bridge.devicesReady ||
                        !bridge.jobsReady ||
                        !bridge.installationsReady
                    }
                    onChange={choose}
                    className="rag-ui__select"
                    options={choices.map((item) => ({
                        value: ragUiInstallationKey(item),
                        label: `${item.name} · ${item.assetKind === 'mcp' ? 'MCP' : 'плагин'} · версия ${item.version}`,
                    }))}
                />
            )}
            <Space wrap>
                <Button
                    icon={<ExportOutlined />}
                    disabled={!!reason || operation.busy || pending}
                    loading={operation.busy || pending}
                    onClick={open}
                >
                    {operation.error
                        ? 'Проверить и повторить открытие'
                        : ['failed', 'cancelled'].includes(job?.state ?? '')
                          ? 'Повторить открытие OpenCodeRAG'
                          : 'Открыть OpenCodeRAG в отдельном окне'}
                </Button>
                {reason && !pending && (
                    <Typography.Text type="secondary" className="rag-ui__reason">
                        {reason}
                    </Typography.Text>
                )}
            </Space>
            {reason.includes('Обновите мост') && (
                <Button className="rag-ui__next" href="/start">
                    Обновить мост
                </Button>
            )}
            {reason.startsWith('Установите или обновите OpenCodeRAG') && (
                <Button
                    className="rag-ui__next"
                    href={`/store?${new URLSearchParams({ p: projectId, q: 'OpenCodeRAG' })}`}
                >
                    Установить или обновить OpenCodeRAG
                </Button>
            )}
            {operation.busy && !pending && (
                <Typography.Text role="status" aria-live="polite">
                    Передаём запрос выбранному мосту…
                </Typography.Text>
            )}
            {pending && (
                <div role="status" aria-live="polite">
                    <Typography.Text>{job?.message || 'Открываем локальный интерфейс…'}</Typography.Text>
                    <Progress percent={percent} status="active" showInfo={percent !== undefined} />
                </div>
            )}
            {job && !pending && (
                <Alert
                    showIcon
                    type={outcome ? 'info' : job.state === 'failed' ? 'error' : 'warning'}
                    role="status"
                    message={
                        outcome
                            ? outcome.reused
                                ? 'Окно OpenCodeRAG уже открыто на компьютере моста'
                                : 'Интерфейс OpenCodeRAG открыт на компьютере моста'
                            : job.state === 'failed'
                              ? 'Не удалось открыть интерфейс OpenCodeRAG'
                              : job.state === 'cancelled'
                                ? 'Открытие OpenCodeRAG отменено'
                                : 'Открытие окна не подтверждено'
                    }
                    description={
                        outcome?.note ||
                        (['failed', 'cancelled'].includes(job.state)
                            ? job.message
                            : 'Обновите данные моста и повторите открытие.')
                    }
                />
            )}
            {operation.error && (
                <Alert
                    role="alert"
                    showIcon
                    type="error"
                    message={operation.error}
                    action={
                        <Button
                            loading={bridge.loading}
                            onClick={() => {
                                void bridge.reload();
                            }}
                        >
                            Обновить данные
                        </Button>
                    }
                />
            )}
        </Space>
    );
}
