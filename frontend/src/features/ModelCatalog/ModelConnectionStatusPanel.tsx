import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { Button, Progress, Space, Tag } from 'antd';
import { useProviderAccessStatus } from '../RemoteProviderAccess/hooks/useProviderAccessStatus';
import type { OpenCodeProviderStatus } from '../OpenCodeProviders/interfaces';
import {
    latestProviderStatus,
    matchingProviderJobs,
    providerKindForModel,
    providerModelEligible,
    providerSetupTarget,
} from '../OpenCodeProviders/model';
import type { useBridge } from '../McpBridge/hooks/useBridge';
import { reindexPending, type IProjectReindexPlan } from '../ProjectEmbedding/reindex';
import { useModelConnectionView } from './hooks/useModelConnectionView';
import type { useModelHosting } from './hooks/useModelHosting';
import type { ICatalogModel } from './interfaces';
import { modelHostingLabels, unverifiedStatusLabel } from './modelCatalogState';

/** План переиндексации передаётся карточкой, не запрашивается повторно. */
export interface IConnectionStatusReindex {
    plan?: IProjectReindexPlan;
    busy: boolean;
    start: () => void;
    retry: () => void;
    cancel: () => void;
}

interface IProps {
    model: ICatalogModel;
    canManage: boolean;
    personalAccess?: boolean;
    hosting: ReturnType<typeof useModelHosting>;
    onConfigure?: () => void;
    onProviderAccess?: () => void;
    onSetupProvider?: () => void;
    bridge?: ReturnType<typeof useBridge>;
    projectId?: string;
    reindex?: IConnectionStatusReindex;
}

const authModeLabels = {
    none: 'Без ключа',
    optional: 'Личный ключ необязателен',
    required: 'Личный API-ключ обязателен',
} as const;

/** Статус локального провайдера OpenCode считается из уже загруженной очереди моста; строка видна только с разрешимой целью. */
const localProviderState = (
    bridge: ReturnType<typeof useBridge>,
    projectId: string,
    model: ICatalogModel,
): { state: 'unverified' | OpenCodeProviderStatus['state']; label: string } | undefined => {
    const kind = providerKindForModel(model);
    if (!kind || !model.modelPin) return undefined;
    const { target } = providerSetupTarget(bridge, projectId, kind);
    if (!target) return undefined;
    const selection = { ...target, providerKind: kind, catalogModelId: model.id, expectedModelPin: model.modelPin };
    const status = latestProviderStatus(matchingProviderJobs(bridge.jobs, selection), selection);
    if (!status) return { state: 'unverified', label: unverifiedStatusLabel };
    const labels = {
        configured: 'Настроен',
        missing: 'Не настроен',
        'login-required': 'Нужен вход',
        unavailable: 'Недоступен',
        conflict: 'Конфликт настроек',
    } as const;
    return { state: status.state, label: labels[status.state] };
};

/**
 * Панель «Статус подключения» (8.19 P2-1): общий адрес, личный ключ, проверка API,
 * локальный провайдер OpenCode и план переиндексации в одном месте карточки.
 * Каждое состояние ведёт в существующий поток настройки — новых модальных окон нет.
 */
export function ModelConnectionStatusPanel({
    model,
    canManage,
    personalAccess = false,
    hosting,
    onConfigure,
    onProviderAccess,
    onSetupProvider,
    bridge,
    projectId,
    reindex,
}: IProps): JSX.Element {
    const {
        view: connection,
        loading: connectionLoading,
        error: connectionError,
    } = useModelConnectionView(model.id, canManage);
    const access = useProviderAccessStatus(model.id, personalAccess);
    const { hosting: hostingState, loading: hostingLoading, busy: hostingBusy, error: hostingError, operate } = hosting;
    const operation = hostingState?.operation;
    const percent =
        typeof operation?.progress === 'number' ? Math.max(0, Math.min(100, operation.progress)) : undefined;
    const hostingLabel = hostingState
        ? hostingState.state === 'stopped'
            ? unverifiedStatusLabel
            : hostingState.state === 'error'
              ? 'Ошибка подключения'
              : modelHostingLabels[hostingState.state]
        : hostingLoading
          ? 'Проверяем подключение…'
          : unverifiedStatusLabel;
    const hostingMessage =
        hostingError || (operation?.state === 'failed' ? operation.message : undefined) || hostingState?.message;
    const local =
        projectId && bridge && providerModelEligible(model) ? localProviderState(bridge, projectId, model) : undefined;
    const plan = reindex?.plan;
    const showPlan =
        !!plan &&
        plan.data.modelId === model.id &&
        (reindexPending(plan) || plan.state === 'needs_input' || plan.state === 'failed');
    const busy = hostingBusy || reindex?.busy === true;
    return (
        <div className="model-connection-status" aria-label={`Статус подключения модели ${model.name}`}>
            <div className="model-connection-status__row">
                <span className="model-connection-status__label">Общее подключение</span>
                <span className="model-connection-status__value">
                    {canManage ? (
                        connectionError ? (
                            <span className="model-connection-status__error">{connectionError}</span>
                        ) : connectionLoading && !connection ? (
                            'Проверяем…'
                        ) : connection ? (
                            <>
                                <span title={connection.baseUrl}>{connection.baseUrl}</span>
                                <span className="model-connection-status__hint">
                                    · {authModeLabels[connection.authMode ?? 'none']}
                                </span>
                                {onConfigure && (
                                    <Button
                                        type="link"
                                        size="small"
                                        className="model-connection-status__action"
                                        onClick={onConfigure}
                                    >
                                        Настроить
                                    </Button>
                                )}
                            </>
                        ) : (
                            <>
                                «не настроено»
                                {onConfigure && (
                                    <Button
                                        type="link"
                                        size="small"
                                        className="model-connection-status__action"
                                        onClick={onConfigure}
                                    >
                                        Настроить
                                    </Button>
                                )}
                            </>
                        )
                    ) : (
                        <span className="model-connection-status__hint">
                            — общий адрес провайдера настраивает главный администратор
                        </span>
                    )}
                </span>
            </div>
            <div className="model-connection-status__row">
                <span className="model-connection-status__label">Мой ключ</span>
                <span className="model-connection-status__value">
                    {personalAccess ? (
                        access.error ? (
                            <span className="model-connection-status__error">{access.error}</span>
                        ) : (
                            <Tag color={access.view?.hasKey ? 'green' : undefined}>
                                {access.loading
                                    ? 'Проверяем доступ…'
                                    : access.view
                                      ? access.view.hasKey
                                          ? 'Личный ключ сохранён'
                                          : access.view.authMode === 'required'
                                            ? 'Нужен ваш API-ключ'
                                            : 'Без личного ключа'
                                      : 'Статус не проверен'}
                            </Tag>
                        )
                    ) : (
                        <span className="model-connection-status__hint">—</span>
                    )}
                    {personalAccess && onProviderAccess && (
                        <Button
                            type="link"
                            size="small"
                            className="model-connection-status__action"
                            onClick={onProviderAccess}
                        >
                            Настроить
                        </Button>
                    )}
                </span>
            </div>
            <div className="model-connection-status__row">
                <span className="model-connection-status__label">Проверка API</span>
                <span className="model-connection-status__value" title={hostingMessage || undefined}>
                    {hostingLabel}
                    {hostingState?.checkedAt && (
                        <span className="model-connection-status__hint">
                            {' '}
                            · проверено {new Date(hostingState.checkedAt).toLocaleString('ru-RU')}
                        </span>
                    )}
                </span>
            </div>
            {hostingBusy && (
                <div role="status" aria-live="polite" className="model-connection-status__progress">
                    <span>{operation?.message || 'Выполняем проверку…'}</span>
                    <Progress size="small" percent={percent} status="active" showInfo={percent !== undefined} />
                </div>
            )}
            {(hostingError || operation?.state === 'failed') && (
                <div role="alert" className="model-connection-status__error">
                    {hostingMessage}
                    {onProviderAccess &&
                        typeof hostingMessage === 'string' &&
                        hostingMessage.includes('«Мой доступ»') && (
                            <Button
                                type="link"
                                size="small"
                                className="model-runtime__setup-access"
                                onClick={onProviderAccess}
                            >
                                Настроить «Мой доступ»
                            </Button>
                        )}
                </div>
            )}
            {canManage &&
                !busy &&
                hostingState &&
                (hostingState.state === 'stopped' || hostingState.state === 'error') && (
                    <FeatureButton
                        features={['model_hosting']}
                        size="small"
                        className="model-connection-status__check"
                        onClick={() => {
                            void operate('check');
                        }}
                    >
                        Проверить подключение
                    </FeatureButton>
                )}
            {local && (
                <div className="model-connection-status__row">
                    <span className="model-connection-status__label">Локальный провайдер OpenCode</span>
                    <span className="model-connection-status__value">
                        <span className={local.state === 'configured' ? 'model-connection-status__ok' : undefined}>
                            {local.label}
                        </span>
                        {onSetupProvider && (
                            <Button
                                type="link"
                                size="small"
                                className="model-connection-status__action"
                                onClick={onSetupProvider}
                            >
                                Настроить провайдера в OpenCode
                            </Button>
                        )}
                    </span>
                </div>
            )}
            {showPlan && plan && (
                <>
                    <div className="model-connection-status__row">
                        <span className="model-connection-status__label">План переиндексации</span>
                        <span className="model-connection-status__value">
                            <Tag
                                color={
                                    plan.state === 'failed' ? 'red' : plan.state === 'needs_input' ? 'orange' : 'blue'
                                }
                            >
                                {plan.state === 'needs_input'
                                    ? 'Нужно подтверждение'
                                    : plan.state === 'failed'
                                      ? 'Ошибка'
                                      : plan.state === 'building'
                                        ? 'Переиндексация'
                                        : plan.state === 'preparing'
                                          ? 'Подготовка'
                                          : plan.state === 'ready'
                                            ? 'Готов к запуску'
                                            : plan.state === 'cancelling'
                                              ? 'Отмена'
                                              : 'Выполняется'}
                            </Tag>
                            <span className="model-connection-status__hint">{plan.message}</span>
                        </span>
                    </div>
                    {plan.state === 'needs_input' && !busy && (
                        <Space wrap className="model-connection-status__plan-actions">
                            <Button size="small" type="primary" onClick={reindex!.start}>
                                Подтвердить
                            </Button>
                            <Button size="small" onClick={reindex!.cancel}>
                                Отменить
                            </Button>
                        </Space>
                    )}
                    {plan.state === 'failed' && !busy && (
                        <Space wrap className="model-connection-status__plan-actions">
                            <Button size="small" type="primary" onClick={reindex!.retry}>
                                Повторить
                            </Button>
                            <Button size="small" onClick={reindex!.cancel}>
                                Отменить
                            </Button>
                        </Space>
                    )}
                    {(plan.state === 'preparing' || plan.state === 'building' || plan.state === 'ready') && (
                        <div role="status" aria-live="polite" className="model-connection-status__progress">
                            <Progress
                                size="small"
                                percent={plan.progress}
                                status={plan.state === 'building' ? 'active' : 'normal'}
                            />
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
