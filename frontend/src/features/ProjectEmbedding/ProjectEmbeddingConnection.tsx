import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { Alert, Button, Checkbox, Progress, Space, Typography } from 'antd';
import { useRef, useState } from 'react';
import { useBridge } from '../McpBridge/hooks/useBridge';
import { useLocalJob } from '../McpBridge/hooks/useLocalJob';
import type { IBridgeJob } from '../McpBridge/api';
import { isPending } from '../McpBridge/installationHelpers';
import { embeddingConnected, pendingEmbeddingAction, type TEmbeddingConnectionInput } from './connection';
import type { IProjectEmbedding } from './model';
import { useAuthRequestOwner } from '../UserBlock/hooks/useAuthRequestOwner';
import type { IRagUiPreference } from '../McpBridge/ragUi/ragUiPreference';

/** Новый запуск требует нового согласия; потерянный ACK проверяется прежним requestKey. */
export function ConnectEmbeddingAction({
    input,
    selection,
    bridge,
    disabled,
    consent,
}: {
    input: TEmbeddingConnectionInput;
    selection: IProjectEmbedding;
    bridge: ReturnType<typeof useBridge>;
    disabled: boolean;
    consent: string;
    onPreferRagUi?: (value: IRagUiPreference) => void;
}): JSX.Element {
    const { scope: owner, captureOwner } = useAuthRequestOwner();
    const operation = useLocalJob(bridge);
    const scopeKey = JSON.stringify([owner, input]);
    const currentScope = useRef({ key: scopeKey, indexed: false });
    if (currentScope.current.key !== scopeKey) currentScope.current = { key: scopeKey, indexed: false };
    const scope = currentScope.current;
    const [approval, setApproval] = useState<{ scope: typeof scope; checked: boolean }>();
    const confirmed = approval?.scope === scope && approval.checked;
    const pending = pendingEmbeddingAction(bridge.jobs, input.deviceId, input.projectId, input.expectedBindingId);
    const retrying = operation.canRetry(input);
    const sameTarget = (candidate: IBridgeJob): boolean =>
        candidate.kind === 'connect-rag-model' &&
        candidate.deviceId === input.deviceId &&
        candidate.projectId === input.projectId &&
        candidate.assetId === input.assetId &&
        candidate.assetKind === input.assetKind &&
        Number(candidate.version) === input.version &&
        candidate.expectedManifest === input.expectedManifest &&
        candidate.bindingId === input.expectedBindingId &&
        candidate.expectedInstanceId === input.expectedInstanceId;
    const local = operation.job && sameTarget(operation.job) ? operation.job : undefined;
    const history = bridge.jobsReady ? bridge.jobs.filter(sameTarget) : [];
    const verified = history.find((candidate) => embeddingConnected(candidate, selection));
    if (verified || embeddingConnected(local, selection)) scope.indexed = true;
    const job = retrying || operation.busy ? undefined : history.find(isPending) || local || verified;
    const success = embeddingConnected(job, selection);
    const blocked = disabled || operation.busy || !bridge.jobsReady || (!retrying && (isPending(job) || pending));
    const reindex = job?.result?.reindex as { rowCount: number } | undefined;
    return (
        <Space id="project-index-actions" direction="vertical" size={12}>
            <Typography.Text strong>Индекс проекта на выбранном компьютере</Typography.Text>
            <Checkbox
                checked={!!confirmed}
                disabled={blocked || retrying}
                onChange={(event) => {
                    if (currentScope.current === scope) setApproval({ scope, checked: event.target.checked });
                }}
            >
                {consent}
            </Checkbox>
            <FeatureButton
                features={retrying ? [] : ['rag_sync', 'computer_connections', 'model_hosting']}
                type="primary"
                loading={operation.busy || (!retrying && isPending(job))}
                disabled={blocked || (!retrying && !confirmed)}
                onClick={() => {
                    if (currentScope.current !== scope || !captureOwner()() || blocked || (!retrying && !confirmed))
                        return;
                    setApproval({ scope, checked: false });
                    void operation.submit(input);
                }}
            >
                {operation.busy
                    ? 'Передаём задание…'
                    : retrying
                      ? 'Проверить отправленную индексацию'
                      : scope.indexed
                        ? 'Обновить индекс'
                        : 'Индексировать проект'}
            </FeatureButton>
            {retrying && !operation.busy && (
                <Alert
                    role="status"
                    type="warning"
                    showIcon
                    message="Ответ на запуск индексации не получен"
                    description="Проверьте отправленную индексацию: будет использован прежний запрос, без второго запуска."
                />
            )}
            {job && !success && (
                <Alert
                    role="status"
                    showIcon
                    type={job.state === 'failed' ? 'error' : 'info'}
                    message={job.message}
                    description={
                        job.state === 'succeeded'
                            ? 'Подключение не подтверждено для текущей модели. Обновите сведения и повторите проверку.'
                            : undefined
                    }
                />
            )}
            {isPending(job) && <Progress percent={job?.percent} status="active" />}
            {pending && !isPending(job) && !retrying && (
                <Typography.Text type="secondary">Дождитесь завершения текущего действия с папкой.</Typography.Text>
            )}
            {(isPending(job) || pending) && <Button href="/operations">Ход операции</Button>}
            {job?.state === 'queued' && (
                <Typography.Text type="secondary">
                    Ожидающее задание можно отменить в разделе «Операции».
                </Typography.Text>
            )}
            {operation.error && <Alert role="alert" type="error" showIcon message={operation.error} />}
            {success && (
                <Alert
                    role="status"
                    type="success"
                    showIcon
                    message="Индекс проекта готов"
                    description={
                        <>
                            Локальный индекс перестроен и синхронизирован с сервером. Перезапустите OpenCode, чтобы
                            открытая сессия использовала новое подключение.{' '}
                            <Typography.Link href={`/projects/${encodeURIComponent(input.projectId)}?tab=rag`}>
                                Открыть вкладку «База знаний»
                            </Typography.Link>
                        </>
                    }
                />
            )}
            {success && (
                <>
                    <Typography.Paragraph type="secondary">
                        Серверная копия обновлена. Фрагментов: {reindex?.rowCount}. После изменения файлов можно
                        обновить индекс здесь.
                    </Typography.Paragraph>
                    <Button type="link" href={`/projects/${encodeURIComponent(input.projectId)}?tab=rag`}>
                        Серверная база знаний
                    </Button>
                </>
            )}
        </Space>
    );
}
