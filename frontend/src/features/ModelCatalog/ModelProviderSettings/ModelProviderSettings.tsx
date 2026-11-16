import { Button, Space, Tag, Typography } from 'antd';
import { useSelector } from 'react-redux';
import { FeatureButton, useFeatureAvailability } from '../../FeatureFlags/FeatureAvailability';
import { useProviderAccessStatus } from '../../RemoteProviderAccess/hooks/useProviderAccessStatus';
import { roleLevel } from '../../UserBlock/roles';
import type { TRootState } from '../../../store';
import type { IModelProviderSettingsProps } from './interfaces';
import './ModelProviderSettings.less';

/**
 * Детали модели показывают только статус личного ключа и ведут в «Мой доступ» (8.19 P1-2):
 * ввод ключа существует только в ProviderAccessModal.
 */
export function ModelProviderSettings({
    model,
    canManage,
    busy,
    onConfigure,
    onProviderAccess,
}: IModelProviderSettingsProps): JSX.Element {
    const user = useSelector((state: TRootState) => state.userBlock.user);
    // Same gate as RemoteProviderAccess: only users who see «Мой доступ» get the status.
    const personalAccess = !!user && user.userRoles.includes(user.activeRole) && roleLevel(user.activeRole) >= 2;
    const availability = useFeatureAvailability('personal_remote_provider_credentials');
    const status = useProviderAccessStatus(model.id, personalAccess && availability.enabled);
    return (
        <section className="model-provider-settings" aria-label="Мой доступ">
            <Space direction="vertical" className="model-provider-settings__content">
                <Typography.Text strong>Мой доступ</Typography.Text>
                <Typography.Text type="secondary">
                    Запросы к этому провайдеру выполняются с сервера Нейроцентра. Личный ключ используется только для
                    вашего доступа.
                </Typography.Text>
                {canManage && !model.archivedAt && onConfigure ? (
                    <FeatureButton features={['model_catalog']} disabled={busy} onClick={onConfigure}>
                        Общие настройки провайдера
                    </FeatureButton>
                ) : (
                    <Typography.Text type="secondary">
                        Общий адрес провайдера настраивает главный администратор.
                    </Typography.Text>
                )}
                {personalAccess &&
                    (availability.enabled ? (
                        <Space wrap>
                            {status.error ? (
                                <Typography.Text type="warning">{status.error}</Typography.Text>
                            ) : (
                                <Tag color={status.view?.hasKey ? 'green' : undefined}>
                                    {status.loading
                                        ? 'Проверяем доступ…'
                                        : status.view
                                          ? status.view.hasKey
                                              ? 'Личный ключ сохранён'
                                              : status.view.authMode === 'required'
                                                ? 'Нужен ваш API-ключ'
                                                : 'Без личного ключа'
                                          : 'Статус не проверен'}
                                </Tag>
                            )}
                            {onProviderAccess && (
                                <Button
                                    size="small"
                                    disabled={busy}
                                    onClick={() => {
                                        onProviderAccess();
                                    }}
                                >
                                    Мой доступ
                                </Button>
                            )}
                        </Space>
                    ) : (
                        <Typography.Text type="secondary">{availability.reason}</Typography.Text>
                    ))}
            </Space>
        </section>
    );
}
