import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { useEmbeddingTarget, EmbeddingTargetFields } from './EmbeddingTarget';
import { Alert, Button, Card, Select, Space, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useAuthRequestOwner } from '../UserBlock/hooks/useAuthRequestOwner';
import { useSelector } from 'react-redux';
import type { TRootState } from '../../store';
import type { IRagIndexProfile } from '../../core/api/interfaces';
import { isMainAdminRole, projectRoleLevel } from '../UserBlock/roles';
import { eligibleEmbedding, embeddingNeedsRepair, sameEmbeddingProfile, selectedEmbeddingMatches, sha } from './model';
import { embeddingTargetConnected } from './connection';
import { useProjectReindex } from './hooks/useProjectReindex';
import { useRagAutoCycle } from './hooks/useRagAutoCycle';
import { ProjectReindexStatus } from './ProjectReindexStatus';
import { useProjectEmbedding } from './hooks/useProjectEmbedding';
import { ConnectEmbeddingAction } from './ProjectEmbeddingConnection';
import { RemoteConnectionModal } from '../ModelCatalog/RemoteConnectionModal';
import { ProviderAccessModal } from '../ModelCatalog/ProviderAccessModal';
import type { ICatalogModel } from '../ModelCatalog/interfaces';
import { useConnectSequence, type IConnectRunResult } from '../ModelCatalog/hooks/useConnectSequence';
import { connectionTargetLabel, observeConnectRun, planConnectStep } from '../ModelCatalog/hooks/connectPlan';
import { unverifiedStatusLabel } from '../ModelCatalog/modelCatalogState';
import './ProjectEmbedding.less';
import type { IRagUiPreference } from '../McpBridge/ragUi/ragUiPreference';

interface IProps {
    projectId: string;
    indexProfile?: IRagIndexProfile | null;
    serverHasData: boolean;
    onPreferRagUi?: (value: IRagUiPreference) => void;
}
/** Локальный выбор и запросы принадлежат точному проекту, роли и сеансу. */
export function ProjectEmbedding(props: IProps): JSX.Element {
    const { scope } = useAuthRequestOwner();
    const user = useSelector((state: TRootState) => state.userBlock.user);
    const level = projectRoleLevel(user, props.projectId);
    return (
        <ProjectEmbeddingContent
            key={JSON.stringify([scope, props.projectId, level])}
            {...props}
            canManage={level >= 3}
            canConnect={level >= 2}
            isMain={isMainAdminRole(user?.activeRole)}
        />
    );
}
export function ProjectEmbeddingContent({
    projectId,
    indexProfile,
    serverHasData,
    canManage,
    canConnect,
    isMain = false,
    onPreferRagUi,
}: IProps & { canManage: boolean; canConnect: boolean; isMain?: boolean }): JSX.Element {
    const state = useProjectEmbedding(projectId),
        target = useEmbeddingTarget(projectId);
    const reindex = useProjectReindex(projectId, state.applied);
    const autoCycle = useRagAutoCycle(reindex);
    const { selection, catalog, modelId } = state;
    /** Шаг «Готовность» единого потока: смена модели проекта (на сервер и выбранную установку). */
    const connect = async (model: ICatalogModel): Promise<IConnectRunResult> => {
        if (!state.selection)
            return { ok: false, error: 'Не удалось подготовить подключение модели. Повторите попытку.' };
        return await reindex.request(model, state.selection.revision, canConnect ? target.value : undefined);
    };
    /** Единый адаптивный поток подключения: подключение → ключ (при authMode) → готовность. */
    const sequence = useConnectSequence({
        plan: (model: ICatalogModel) => planConnectStep(model, isMain),
        run: connect,
    });
    const [connection, setConnection] = useState<ICatalogModel | null>(null);
    const [providerAccess, setProviderAccess] = useState<{ model: ICatalogModel; notice?: string } | null>(null);
    const connectionReady = (model: ICatalogModel): boolean =>
        selectedEmbeddingMatches(selection, model) &&
        (target.mode === 'server' ||
            (!!target.value && target.ready && embeddingTargetConnected(target.bridge.jobs, selection, target.value)));
    useEffect(() => {
        if (sequence.phase === 'connection' && sequence.model) setConnection(sequence.model);
        else if (sequence.phase === 'access' && sequence.model)
            setProviderAccess({
                model: sequence.model,
                notice: 'Провайдер требует личный ключ. Введите ключ, чтобы завершить подключение.',
            });
    }, [sequence.phase, sequence.model]);
    useEffect(() => {
        if (sequence.phase !== 'run' || !sequence.model) return;
        const outcome = observeConnectRun(sequence.model, {
            connected: connectionReady(sequence.model),
            plan: reindex.plan,
            reindexError: reindex.error,
            pending: reindex.pending,
        });
        if (outcome.state === 'ready') sequence.markReady();
        else if (outcome.state === 'failed')
            sequence.markFailed(outcome.message ?? 'Не удалось подключить модель. Повторите попытку.');
    });
    const assigned = new Set(catalog?.assignedModelIds ?? []);
    const models = selection
        ? (catalog?.items.filter(
              (model) =>
                  assigned.has(model.id) &&
                  eligibleEmbedding(model) &&
                  (!model.archivedAt || (model.id === selection.model?.id && model.modelPin === selection.modelPin)),
          ) ?? [])
        : [];
    const selected = models.find((model) => model.id === modelId);
    const dirty =
        !!selection &&
        (modelId !== (selection.model?.id ?? null) ||
            embeddingNeedsRepair(selection) ||
            (!!selected && sha(selected.modelPin) && selected.modelPin !== selection.modelPin));
    const invalidDraft = modelId !== null && !selected;
    const mismatch =
        serverHasData &&
        !!selection?.profile &&
        (!indexProfile || !sameEmbeddingProfile(indexProfile, selection.profile));
    const catalogUrl = `/projects/${encodeURIComponent(projectId)}?tab=store&catalogTab=models`;
    const showTarget =
        canConnect &&
        (!!selected ||
            (!!selection?.model && modelId === selection.model.id && (state.catalogLoading || !!state.catalogError)));
    const saveAction =
        canManage && selection && (!!modelId || dirty || mismatch) ? (
            <FeatureButton
                features={selected ? ['model_catalog', 'rag_sync', 'model_hosting'] : []}
                type="primary"
                loading={state.saving || reindex.busy}
                disabled={
                    !(dirty || mismatch) ||
                    invalidDraft ||
                    state.loading ||
                    state.catalogLoading ||
                    reindex.pending ||
                    reindex.plan?.state === 'needs_input' ||
                    !!state.readError ||
                    !!state.catalogError ||
                    (!!modelId && canConnect && target.blocked)
                }
                onClick={() => {
                    if (selected) {
                        if (canConnect && target.blocked) return;
                        void sequence.begin(selected);
                    } else {
                        void state.save();
                    }
                }}
            >
                {modelId ? 'Подключить модель' : 'Отключить модель проекта'}
            </FeatureButton>
        ) : null;
    return (
        <Card
            id="project-index-settings"
            data-project-id={projectId}
            tabIndex={-1}
            role="region"
            aria-label="Настройка индекса проекта"
            size="small"
            title="Модель эмбеддингов проекта"
            className="project-embedding"
            extra={
                <Button
                    type="link"
                    loading={state.loading || state.catalogLoading}
                    disabled={state.saving}
                    onClick={() => {
                        void state.refresh();
                    }}
                >
                    Обновить сведения
                </Button>
            }
        >
            <Space direction="vertical" size={16} className="project-embedding__content">
                {state.readError && (
                    <Alert
                        showIcon
                        type="warning"
                        message="Сведения о модели недоступны"
                        description={state.readError}
                        action={
                            <Button
                                loading={state.loading}
                                disabled={state.saving}
                                onClick={() => {
                                    void state.refresh();
                                }}
                            >
                                Повторить загрузку
                            </Button>
                        }
                    />
                )}
                {state.catalogError && (
                    <Alert
                        showIcon
                        type="warning"
                        message="Каталог моделей недоступен"
                        description={`${state.catalogError} ${state.catalogAccessDenied ? 'Подключение недоступно до актуальной проверки доступа.' : 'Изменение выбора недоступно; сохранённая модель читается отдельно.'}`}
                        action={
                            <Button
                                loading={state.catalogLoading}
                                disabled={state.saving}
                                onClick={() => {
                                    void state.refresh();
                                }}
                            >
                                Повторить загрузку каталога
                            </Button>
                        }
                    />
                )}
                {!selection && state.loading && <Spin />}
                {selection && (
                    <>
                        <div className="project-embedding__stage">
                            <Typography.Text strong>1. Модель проекта</Typography.Text>
                            <Typography.Text>
                                Сохранённая модель: <strong>{selection.model?.name || 'не выбрана'}</strong>
                                {selection.model
                                    ? ` · ${selection.model.model} · ${selection.model.dimension} измерений`
                                    : ''}
                                .
                            </Typography.Text>
                            {canManage ? (
                                <Space direction="vertical" size={8} className="project-embedding__selection">
                                    <Select
                                        aria-label="Модель эмбеддингов проекта"
                                        placeholder="Выберите назначенную embedding-модель"
                                        value={modelId ?? undefined}
                                        allowClear
                                        showSearch
                                        optionFilterProp="label"
                                        disabled={
                                            state.loading ||
                                            state.catalogLoading ||
                                            state.saving ||
                                            reindex.busy ||
                                            reindex.pending ||
                                            reindex.plan?.state === 'needs_input' ||
                                            !!state.readError ||
                                            !!state.catalogError
                                        }
                                        onChange={(id?: string) => state.choose(id ?? null)}
                                        options={models.map((model) => ({
                                            value: model.id,
                                            label: `${model.name} · ${model.dimension} измерений`,
                                        }))}
                                    />
                                    {invalidDraft && !state.catalogError && !state.catalogLoading && (
                                        <Typography.Text type="warning">
                                            Выбранная модель больше не доступна для этого проекта. Выберите другую
                                            модель или очистите выбор.
                                        </Typography.Text>
                                    )}
                                    {!models.length &&
                                        !state.catalogError &&
                                        !state.catalogLoading &&
                                        !selection.blocker && (
                                            <Typography.Text type="secondary">
                                                Добавьте проекту проверенную embedding-модель в каталоге.
                                            </Typography.Text>
                                        )}
                                </Space>
                            ) : (
                                <Typography.Text type="secondary">
                                    Модель выбирает администратор проекта. Подключить её к OpenCodeRAG может разработчик
                                    проекта.
                                </Typography.Text>
                            )}
                            {selection.blocker && !(dirty && selected) && (
                                <Alert type="warning" showIcon message={selection.blocker} />
                            )}
                            <Button size="small" href={catalogUrl}>
                                Открыть модели в каталоге проекта
                            </Button>
                        </div>
                        {showTarget && (
                            <div className="project-embedding__stage">
                                <Typography.Text strong>2. Куда подключить модель</Typography.Text>
                                <EmbeddingTargetFields
                                    target={target}
                                    showTitle={false}
                                    disabled={reindex.busy || reindex.pending || reindex.plan?.state === 'needs_input'}
                                />
                                {saveAction}
                            </div>
                        )}
                        {!showTarget && saveAction}
                        {state.saveError && (
                            <Alert
                                role="alert"
                                type="error"
                                showIcon
                                message={state.saveError}
                                description="Черновик сохранён в форме. Обновите сведения и проверьте текущий выбор перед повторным сохранением."
                            />
                        )}
                        {mismatch && (
                            <Alert
                                type="warning"
                                showIcon
                                message="Модель несовместима с существующей серверной копией"
                                description="Подключите выбранную модель: система подготовит перестройку существующих фрагментов и покажет последствия до начала работы."
                            />
                        )}
                        <ProjectReindexStatus
                            state={reindex}
                            canManage={canManage}
                            autoCycle={autoCycle}
                            onConfirm={(plan) => {
                                if (sequence.model?.id !== plan.data.modelId || sequence.phase !== 'run') {
                                    const model = catalog?.items.find((item) => item.id === plan.data.modelId);
                                    if (model) void sequence.begin(model, 'run', true);
                                }
                                void reindex.start();
                            }}
                        />
                        {sequence.model && sequence.phase === 'run' && (
                            <Alert
                                role="status"
                                type="info"
                                showIcon
                                message={`Подключаем модель «${sequence.model.name}»…`}
                                description="Проверяем подключение и готовим индекс проекта."
                            />
                        )}
                        {sequence.model && sequence.phase === 'ready' && (
                            <Alert
                                role="status"
                                type="success"
                                showIcon
                                message={`Модель «${sequence.model.name}» готова`}
                                description={`Подключение: ${connectionTargetLabel(target.mode, target.device?.name)}.`}
                                action={
                                    <Button
                                        onClick={() => {
                                            sequence.close();
                                        }}
                                    >
                                        Понятно
                                    </Button>
                                }
                            />
                        )}
                        {sequence.model && sequence.phase === 'failed' && (
                            <Alert
                                role="alert"
                                type="error"
                                showIcon
                                message={sequence.error || unverifiedStatusLabel}
                                description="Подключение не подтверждено."
                                action={
                                    <Space wrap>
                                        {sequence.origin === 'reindex' && (
                                            <Button
                                                type="primary"
                                                onClick={() => {
                                                    sequence.retry();
                                                }}
                                            >
                                                Повторить
                                            </Button>
                                        )}
                                        <Button
                                            onClick={() => {
                                                void state.refresh();
                                            }}
                                        >
                                            Проверить подключение
                                        </Button>
                                    </Space>
                                }
                            />
                        )}
                        {selection.model &&
                            selection.modelPin &&
                            selection.profile &&
                            !selection.blocker &&
                            canConnect &&
                            target.value && (
                                <ConnectEmbeddingAction
                                    key={JSON.stringify([target.value, selection.revision, selection.modelPin])}
                                    selection={selection}
                                    input={{
                                        ...target.value,
                                        projectId,
                                        kind: 'connect-rag-model',
                                        expectedEmbeddingRevision: selection.revision,
                                        expectedEmbeddingPin: selection.modelPin,
                                        reindex: true,
                                    }}
                                    bridge={target.bridge}
                                    consent={`Подключить «${selection.model.name}» к выбранной установке на компьютере «${target.device?.name}» и полностью перестроить локальный индекс. Код отправится провайдеру модели через Нейроцентр; прежний индекс сохранится до проверки нового.`}
                                    disabled={
                                        dirty ||
                                        state.loading ||
                                        state.saving ||
                                        reindex.busy ||
                                        reindex.pending ||
                                        !!state.readError ||
                                        state.catalogAccessDenied
                                    }
                                    onPreferRagUi={onPreferRagUi}
                                    onSubmitted={() => {
                                        if (selected) void sequence.begin(selected, 'run', true);
                                    }}
                                    onResult={(result) => {
                                        if (result.ok) sequence.markReady();
                                        else
                                            sequence.markFailed(
                                                result.error || 'Не удалось подключить модель. Повторите попытку.',
                                            );
                                    }}
                                />
                            )}
                    </>
                )}
                {!selection && <Button href={catalogUrl}>Открыть модели в каталоге проекта</Button>}
                <details className="project-embedding__help">
                    <summary>Как меняется модель и индекс</summary>
                    <Typography.Paragraph type="secondary">
                        Модель и размерность задаются для проекта. При смене модели новая база собирается отдельно;
                        команда продолжает работать с текущей до проверенного переключения.
                    </Typography.Paragraph>
                    {serverHasData && (
                        <Typography.Paragraph type="secondary">
                            Профиль существующей серверной копии:{' '}
                            {indexProfile
                                ? `${indexProfile.provider} · ${indexProfile.model} · ${indexProfile.dimension} измерений`
                                : 'не подтверждён'}
                            .
                        </Typography.Paragraph>
                    )}
                    <Typography.Paragraph type="secondary">
                        Подключение к OpenCodeRAG использует только проверенный выбор проекта.
                    </Typography.Paragraph>
                </details>
                {isMain && connection && (
                    <RemoteConnectionModal
                        key={`${connection.id}:${connection.revision}`}
                        model={connection}
                        onClose={() => {
                            setConnection(null);
                            // Отмена формы до сохранения завершает поток; после onSaved шаг уже следующий.
                            sequence.settle(connection.id, 'connection', 'closed');
                        }}
                        onSaved={async (saved) => {
                            const inSequence =
                                sequence.model?.id === connection.id &&
                                (sequence.phase === 'connection' || sequence.phase === 'access');
                            if (!saved || saved.authMode === 'none') {
                                if (inSequence) sequence.advance('done');
                                return;
                            }
                            setProviderAccess({
                                model: connection,
                                notice: 'Провайдер сохранён. Теперь введите ваш личный ключ.',
                            });
                            if (inSequence) sequence.advance('access');
                        }}
                    />
                )}
                {providerAccess && (
                    <ProviderAccessModal
                        model={providerAccess.model}
                        canConfigure={isMain}
                        busy={state.saving || reindex.busy}
                        notice={providerAccess.notice}
                        onConfigure={
                            isMain
                                ? () => {
                                      // «Изменить адрес» в потоке возвращается в шаг «Подключение».
                                      if (sequence.model?.id === providerAccess.model.id && sequence.phase === 'access')
                                          sequence.advance('connection');
                                      setConnection(providerAccess.model);
                                      setProviderAccess(null);
                                  }
                                : undefined
                        }
                        onClose={() => {
                            setProviderAccess(null);
                            // Закрытие «Мой доступ» завершает шаг «Ключ»: переходим к подключению.
                            sequence.settle(providerAccess.model.id, 'access', 'done');
                        }}
                    />
                )}
            </Space>
        </Card>
    );
}
