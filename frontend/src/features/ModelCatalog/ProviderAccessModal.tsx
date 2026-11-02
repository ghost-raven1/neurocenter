import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { Alert, Button, Modal, Space, Typography } from 'antd';
import { useState } from 'react';
import { RemoteProviderAccess } from '../RemoteProviderAccess/RemoteProviderAccess';
import type { ICatalogModel } from './interfaces';
import './ProviderAccessModal.less';

interface IProps {
    model: ICatalogModel;
    canConfigure: boolean;
    busy: boolean;
    notice?: string;
    onConfigure?: () => void;
    onClose: () => void;
}

/** One-click provider + key setup: shared address is role-gated, the personal key stays in «Мой доступ». */
export function ProviderAccessModal({ model, canConfigure, busy, notice, onConfigure, onClose }: IProps): JSX.Element {
    const [open, setOpen] = useState(true);
    // Keep the Modal mounted until AntD restores focus; the parent removes it in afterClose.
    const close = (): void => {
        if (!busy) setOpen(false);
    };
    const configure = canConfigure && !!onConfigure;
    return (
        <Modal
            open={open}
            afterClose={onClose}
            centered
            className="model-details provider-access-modal"
            title={`Провайдер и ключ · «${model.name}»`}
            width={640}
            onCancel={close}
            footer={
                <Button disabled={busy} onClick={close}>
                    Закрыть
                </Button>
            }
        >
            {notice && <Alert showIcon type="success" message={notice} className="model-catalog__notice" />}
            <Space direction="vertical" className="provider-access-modal__content">
                <Typography.Text type="secondary">
                    Запросы к этому провайдеру выполняются с сервера Нейроцентра. Личный ключ используется только для
                    вашего доступа.
                </Typography.Text>
                {configure ? (
                    <FeatureButton features={['model_catalog']} disabled={busy} onClick={onConfigure}>
                        Изменить адрес и настройки провайдера
                    </FeatureButton>
                ) : (
                    <Typography.Text type="secondary">
                        Общий адрес провайдера настраивает главный администратор.
                    </Typography.Text>
                )}
                <RemoteProviderAccess modelId={model.id} />
            </Space>
        </Modal>
    );
}
