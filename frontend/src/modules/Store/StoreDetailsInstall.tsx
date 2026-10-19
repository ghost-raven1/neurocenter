import { DownloadOutlined } from '@ant-design/icons';
import { Alert, Button, Progress } from 'antd';
import type { FC } from 'react';
import { installStatusView, type IStoreInstallStatus } from './storeDetails';

interface IStatusProps { status?: IStoreInstallStatus; busy?: boolean; }

/** Показывает фактический статус задания, переданный родительским экраном. */
const StoreDetailsInstallStatus: FC<IStatusProps> = ({ status, busy }) => {
    const view = installStatusView(status, busy);
    if (!view.title) { return null; }
    return <section className="store-details__installation" aria-label="Установка инструмента">
        <div role="status" aria-live="polite" aria-atomic="true"><Alert type={view.tone} showIcon message={view.title} description={status?.message} /></div>
        {view.percent !== undefined && <Progress percent={view.percent} status={view.progressStatus} format={percent => `${percent}%`} aria-label="Прогресс установки" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent} />}
    </section>;
};

/** Отсутствие разрешённого действия скрывает установку для этой карточки. */
export const StoreDetailsInstallButton: FC<IStatusProps & { onInstall?: () => void; disabled?: boolean }> = ({ status, busy, onInstall, disabled }) => {
    if (!onInstall) { return null; }
    const view = installStatusView(status, busy);
    return <Button type="primary" className="store-details__install-button" icon={<DownloadOutlined />} loading={view.busy} disabled={disabled || view.disabled} onClick={onInstall}>{view.buttonLabel}</Button>;
};

export default StoreDetailsInstallStatus;
