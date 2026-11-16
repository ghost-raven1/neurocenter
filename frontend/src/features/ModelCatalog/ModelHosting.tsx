import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { Alert, Button, Progress, Space, Tag, Typography } from 'antd';
import {
    CheckCircleOutlined,
    ClockCircleOutlined,
    ExclamationCircleOutlined,
    LoadingOutlined,
    ReloadOutlined,
} from '@ant-design/icons';
import type { ICatalogModel } from './interfaces';
import { modelHostingLabels, unverifiedStatusLabel } from './modelCatalogState';
import { useModelHosting } from './hooks/useModelHosting';
import { modelUsesApiConnection } from './modelCatalogState';

export type TModelHostingState = ReturnType<typeof useModelHosting>;

interface IViewProps {
    model: ICatalogModel;
    canManage: boolean;
    state: TModelHostingState;
    compact?: boolean;
    onManage?: () => void;
    onSetupAccess?: () => void;
}

/** Прогресс и содержательная проверка отделены от назначения модели проекту. */
export function ModelHostingView({
    model,
    canManage,
    state,
    compact,
    onManage,
    onSetupAccess,
}: IViewProps): JSX.Element {
    const { hosting, loading, busy, error, refresh, operate } = state;
    const operation = hosting?.operation;
    const remote = modelUsesApiConnection(model),
        deviceCodex = model.runtime === 'device-codex';
    const label = hosting
        ? (remote || deviceCodex) && hosting.state === 'stopped'
            ? unverifiedStatusLabel
            : (remote || deviceCodex) && hosting.state === 'error'
              ? 'Ошибка подключения'
              : modelHostingLabels[hosting.state]
        : loading
          ? 'Проверяем…'
          : 'Не проверен';
    const percent =
        typeof operation?.progress === 'number' ? Math.max(0, Math.min(100, operation.progress)) : undefined;
    if (compact) {
        const stateName = hosting?.state;
        const StatusIcon =
            loading || busy
                ? LoadingOutlined
                : stateName === 'ready'
                  ? CheckCircleOutlined
                  : stateName === 'missing' || stateName === 'stopped'
                    ? ClockCircleOutlined
                    : ExclamationCircleOutlined;
        const message = error || (operation?.state === 'failed' && operation.message) || hosting?.message;
        return (
            <div className={`model-runtime model-runtime_${stateName || 'unknown'}`}>
                <div className="model-runtime__summary">
                    <span title={message || undefined}>
                        <StatusIcon aria-hidden="true" />
                        {loading ? 'Проверяем подключение…' : hosting ? label : unverifiedStatusLabel}
                    </span>
                    <Button
                        type="text"
                        size="small"
                        icon={<ReloadOutlined />}
                        loading={loading}
                        disabled={busy}
                        aria-label={`Обновить статус модели ${model.name}`}
                        onClick={() => {
                            void refresh();
                        }}
                    />
                </div>
                {busy && (
                    <div role="status" aria-live="polite" className="model-runtime__progress">
                        <span>{operation?.message || 'Выполняем действие…'}</span>
                        <Progress size="small" percent={percent} status="active" showInfo={percent !== undefined} />
                    </div>
                )}
                {(error || operation?.state === 'failed') && (
                    <div role="alert" className="model-runtime__error">
                        {message}
                        {onSetupAccess && typeof message === 'string' && message.includes('«Мой доступ»') && (
                            <Button
                                type="link"
                                size="small"
                                className="model-runtime__setup-access"
                                onClick={onSetupAccess}
                            >
                                Настроить «Мой доступ»
                            </Button>
                        )}
                    </div>
                )}
                {!error &&
                    operation?.state !== 'failed' &&
                    (stateName === 'unavailable' || stateName === 'error') &&
                    message && <div className="model-runtime__reason">{message}</div>}
                {canManage &&
                    !busy &&
                    !remote &&
                    !deviceCodex &&
                    (stateName === 'missing' || stateName === 'stopped') && (
                        <FeatureButton
                            features={['model_hosting']}
                            size="small"
                            onClick={() => {
                                void operate('start');
                            }}
                        >
                            {stateName === 'missing' ? 'Подготовить модель' : 'Запустить'}
                        </FeatureButton>
                    )}
                {canManage && !busy && remote && stateName === 'stopped' && (
                    <FeatureButton
                        features={['model_hosting']}
                        size="small"
                        onClick={() => {
                            void operate('check');
                        }}
                    >
                        Проверить подключение
                    </FeatureButton>
                )}
                {canManage && !busy && !remote && !deviceCodex && stateName === 'error' && onManage && (
                    <FeatureButton features={['model_catalog']} size="small" onClick={onManage}>
                        Проверить подключение
                    </FeatureButton>
                )}
            </div>
        );
    }
    return (
        <Space direction="vertical" size={10} className="model-hosting">
            <Space wrap size={4}>
                <Typography.Text strong>
                    {deviceCodex ? 'Codex на компьютере' : remote ? 'Подключение API' : 'Хостинг'}
                </Typography.Text>
                <Tag color={hosting?.state === 'ready' ? 'blue' : hosting?.state === 'error' ? 'red' : undefined}>
                    {label}
                </Tag>
            </Space>
            {hosting?.message && <Typography.Text type="secondary">{hosting.message}</Typography.Text>}
            {busy && (
                <div role="status" aria-live="polite" className="model-hosting__progress">
                    <Typography.Text>{operation?.message || 'Запускаем операцию…'}</Typography.Text>
                    <Progress percent={percent} status="active" showInfo={percent !== undefined} />
                </div>
            )}
            {hosting?.checkedAt && (
                <Typography.Text type="secondary" className="model-hosting__checked">
                    Проверено: {new Date(hosting.checkedAt).toLocaleString('ru-RU')}
                </Typography.Text>
            )}
            {operation?.state === 'failed' && (
                <Alert
                    type="error"
                    showIcon
                    message="Последняя операция завершилась ошибкой"
                    description={operation.message}
                />
            )}
            {error && <Alert type="error" showIcon message={error} />}
            <Space wrap size={8}>
                {canManage && remote && (
                    <>
                        <FeatureButton
                            features={['model_hosting']}
                            type="primary"
                            disabled={busy || loading}
                            onClick={() => {
                                void operate('check');
                            }}
                        >
                            Проверить подключение
                        </FeatureButton>
                        {onManage && (
                            <FeatureButton features={['model_catalog']} disabled={busy || loading} onClick={onManage}>
                                Настроить API
                            </FeatureButton>
                        )}
                    </>
                )}
                {canManage && !remote && !deviceCodex && hosting?.state !== 'unavailable' && (
                    <>
                        <FeatureButton
                            features={['model_hosting']}
                            disabled={busy || loading}
                            loading={busy && operation?.action === 'start'}
                            onClick={() => {
                                void operate('start');
                            }}
                        >
                            Запустить
                        </FeatureButton>
                        <FeatureButton
                            features={['model_hosting']}
                            disabled={busy || loading || hosting?.state === 'missing'}
                            onClick={() => {
                                void operate('check');
                            }}
                        >
                            Проверить модель
                        </FeatureButton>
                        <Button
                            disabled={busy || loading || hosting?.state === 'missing'}
                            onClick={() => {
                                void operate('stop');
                            }}
                        >
                            Выгрузить из памяти
                        </Button>
                    </>
                )}
                <Button
                    type="link"
                    disabled={busy}
                    loading={loading}
                    onClick={() => {
                        void refresh();
                    }}
                >
                    {deviceCodex ? 'Проверить компьютер' : 'Обновить статус'}
                </Button>
            </Space>
        </Space>
    );
}

interface IProps {
    model: ICatalogModel;
    canManage: boolean;
    compact?: boolean;
    onManage?: () => void;
    onSettled?: () => Promise<void>;
    onSetupAccess?: () => void;
}

/** Обёртка над useModelHosting для экранов, где состояние хостинга не нужен выше карточки. */
export function ModelHosting({ model, canManage, compact, onManage, onSettled, onSetupAccess }: IProps): JSX.Element {
    const state = useModelHosting(model, onSettled);
    return (
        <ModelHostingView
            model={model}
            canManage={canManage}
            state={state}
            compact={compact}
            onManage={onManage}
            onSetupAccess={onSetupAccess}
        />
    );
}
