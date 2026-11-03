import { Alert, Button, Space, Typography } from 'antd';
import { useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { modelCatalogApi } from '../ModelCatalog/api';
import type { ICatalogModel } from '../ModelCatalog/interfaces';
import { ProviderAccessModal } from '../ModelCatalog/ProviderAccessModal';
import { RemoteConnectionModal } from '../ModelCatalog/RemoteConnectionModal';
import { useAuthRequestOwner } from '../UserBlock/hooks/useAuthRequestOwner';
import { chatModelSetupActions } from './chatModelSetup';

interface IProps {
    projectId: string;
    items: ICatalogModel[];
    assigned: Set<string>;
    canAssign: boolean;
    canCheck: boolean;
    canConfigure: boolean;
    onRefresh: () => void | Promise<void>;
}

/** The check operation can outlive its request; the status settles on the server. */
const CHECK_POLL_MS = 2000,
    CHECK_POLL_MAX = 30;

/**
 * Model readiness without leaving the chat: every unavailable project model
 * lists its gap and the inline fix (assign, provider + key, connection check).
 * The modal chain mirrors ModelCatalog; a fresh catalog read follows each action.
 */
export function ChatModelSetup({
    projectId,
    items,
    assigned,
    canAssign,
    canCheck,
    canConfigure,
    onRefresh,
}: IProps): JSX.Element {
    const { captureOwner } = useAuthRequestOwner();
    const [busy, setBusy] = useState<string | null>(null),
        [error, setError] = useState(''),
        [access, setAccess] = useState<{ model: ICatalogModel; notice?: string } | null>(null),
        [connection, setConnection] = useState<ICatalogModel | null>(null);
    const lock = useRef(false);
    const rows = items.map((model) => ({
        model,
        ...chatModelSetupActions(model, assigned.has(model.id), canAssign, canCheck),
    }));
    const assign = async (model: ICatalogModel): Promise<void> => {
        if (!canAssign || busy || lock.current) return;
        const owns = captureOwner();
        lock.current = true;
        setBusy(model.id);
        setError('');
        try {
            await modelCatalogApi.assign(projectId, model.id);
            if (owns()) await onRefresh();
        } catch (cause) {
            if (owns()) setError(errorMessage(cause, 'Модель не добавлена в проект. Повторите.'));
        } finally {
            lock.current = false;
            if (owns()) setBusy(null);
        }
    };
    const check = async (model: ICatalogModel): Promise<void> => {
        if (!canCheck || busy || lock.current) return;
        const owns = captureOwner();
        lock.current = true;
        setBusy(model.id);
        setError('');
        try {
            let value = await modelCatalogApi.operate(model, 'check');
            for (let left = CHECK_POLL_MAX; value.operation?.state === 'running' && owns() && left > 0; left--) {
                await new Promise((resolve) => setTimeout(resolve, CHECK_POLL_MS));
                if (!owns()) break;
                value = await modelCatalogApi.hosting(model.id);
            }
            if (owns()) {
                // A finished operation may have failed on the server; keep its reason visible.
                if (value.operation?.state === 'failed')
                    setError(errorMessage(new Error(value.operation.message), 'Проверка не удалась. Повторите.'));
                await onRefresh();
            }
        } catch (cause) {
            if (owns()) setError(errorMessage(cause, 'Проверка подключения не удалась. Повторите.'));
        } finally {
            lock.current = false;
            if (owns()) setBusy(null);
        }
    };
    /** Provider + key setup: access modal first; the shared address is re-opened by the main admin. */
    const openConnection = (): void => {
        if (!access) return;
        const fresh = items.find((item) => item.id === access.model.id) ?? access.model;
        setAccess(null);
        setConnection(fresh);
    };
    /** The modal closes itself after onSaved settles; the key step follows the provider save. */
    const connectionSaved = async (): Promise<void> => {
        const target = connection;
        await onRefresh();
        if (target) setAccess({ model: target, notice: 'Провайдер сохранён. Теперь введите ваш личный ключ.' });
    };
    return (
        <div className="model-chat__setup">
            <Typography.Title level={5} className="model-chat__setup-title">
                Модель для чата
            </Typography.Title>
            <Typography.Text type="secondary" className="model-chat__setup-intro">
                Готовой модели пока нет. Закройте пробелы ниже — чат станет доступен без перехода в каталог.
            </Typography.Text>
            {error && <Alert type="error" showIcon message={error} className="model-chat__setup-error" />}
            {items.length ? (
                <Space direction="vertical" size={14} className="model-chat__setup-list">
                    {rows.map(({ model, reason, actions, hint }) => (
                        <div key={model.id} className="model-chat__setup-row">
                            <div className="model-chat__setup-heading">
                                <Typography.Text strong>{model.name}</Typography.Text>
                                <Typography.Text type="secondary">{reason}</Typography.Text>
                            </div>
                            <Space wrap size={8}>
                                {actions.includes('assign') && (
                                    <Button
                                        size="small"
                                        loading={busy === model.id}
                                        disabled={!!busy && busy !== model.id}
                                        onClick={() => {
                                            void assign(model);
                                        }}
                                    >
                                        Добавить в проект
                                    </Button>
                                )}
                                {actions.includes('provider') && (
                                    <Button
                                        size="small"
                                        disabled={!!busy}
                                        onClick={() => {
                                            setAccess({ model });
                                        }}
                                    >
                                        Настроить провайдера и ключ
                                    </Button>
                                )}
                                {actions.includes('check') && (
                                    <FeatureButton
                                        features={['model_hosting']}
                                        size="small"
                                        loading={busy === model.id}
                                        disabled={!!busy && busy !== model.id}
                                        onClick={() => {
                                            void check(model);
                                        }}
                                    >
                                        Проверить подключение
                                    </FeatureButton>
                                )}
                                {hint && (
                                    <Typography.Text type="secondary" className="model-chat__setup-hint">
                                        {hint}
                                    </Typography.Text>
                                )}
                            </Space>
                        </div>
                    ))}
                </Space>
            ) : (
                <Typography.Text type="secondary" className="model-chat__setup-empty">
                    В каталоге нет моделей, которые можно добавить в этот проект для чата. Добавьте модель кнопкой
                    «Подключить модель».
                </Typography.Text>
            )}
            {access && (
                <ProviderAccessModal
                    model={access.model}
                    canConfigure={canConfigure}
                    busy={!!busy}
                    notice={access.notice}
                    onConfigure={canConfigure ? openConnection : undefined}
                    onClose={() => setAccess(null)}
                />
            )}
            {connection && (
                <RemoteConnectionModal
                    key={`${connection.id}:${connection.revision}`}
                    model={connection}
                    onClose={() => setConnection(null)}
                    onSaved={connectionSaved}
                />
            )}
        </div>
    );
}
