import { Space, Typography } from 'antd';
import { FeatureButton } from '../../FeatureFlags/FeatureAvailability';
import { RemoteProviderAccess } from '../../RemoteProviderAccess/RemoteProviderAccess';
import type { IModelProviderSettingsProps } from './interfaces';
import './ModelProviderSettings.less';

/** The personal key and shared endpoint keep their existing owners and independent permissions. */
export function ModelProviderSettings({
    model,
    canManage,
    busy,
    onConfigure,
}: IModelProviderSettingsProps): JSX.Element {
    return (
        <section className="model-provider-settings" aria-label="Провайдер и API-ключ">
            <Space direction="vertical" className="model-provider-settings__content">
                <Typography.Text strong>Провайдер и API-ключ</Typography.Text>
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
                <RemoteProviderAccess modelId={model.id} />
            </Space>
        </section>
    );
}
