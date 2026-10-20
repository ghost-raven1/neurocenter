import { AppleOutlined, CheckCircleFilled, CheckOutlined, ClockCircleOutlined, DownOutlined, LaptopOutlined, LinuxOutlined, MoreOutlined, QuestionCircleOutlined, WindowsOutlined } from '@ant-design/icons';
import { Button, Dropdown } from 'antd';
import type { IBridgeDevice } from './api';
import { BridgeDeviceDetails } from './BridgeDeviceDetails';

interface BridgeDeviceCardProps {
    device: IBridgeDevice;
    selected: boolean;
    verified: boolean;
    busy: boolean;
    disconnecting: boolean;
    folderLabel?: string;
    onChoose: () => void;
    onRevoke: () => void;
}

/** Имя, статус и выбор читаются сразу; технические сведения и отзыв доступны по запросу. */
export function BridgeDeviceCard({ device, selected, verified, busy, disconnecting, folderLabel, onChoose, onRevoke }: BridgeDeviceCardProps) {
    const PlatformIcon = device.report.platform === 'darwin' ? AppleOutlined : device.report.platform === 'win32' ? WindowsOutlined : device.report.platform === 'linux' ? LinuxOutlined : LaptopOutlined;
    const status = !verified ? 'unverified' : device.requiresReconnect ? 'expired' : device.online ? 'online' : 'offline';
    const StatusIcon = status === 'online' ? CheckCircleFilled : status === 'expired' ? ClockCircleOutlined : status === 'unverified' ? QuestionCircleOutlined : ClockCircleOutlined;
    const statusLabel = { online: 'На связи', offline: 'Не в сети', expired: 'Нужно переподключить', unverified: 'Статус не проверен' }[status];
    return <article className={`bridge-device-card${selected ? ' bridge-device-card_selected' : ''}`} aria-label={device.name}>
        <div className="bridge-device-card__main">
            <div className="bridge-device-card__icon" aria-hidden="true"><PlatformIcon /></div>
            <div className="bridge-device-card__identity">
                <h3 className="bridge-device-card__name">{device.name}</h3>
                <div className={`bridge-device-card__status bridge-device-card__status_${status}`}><StatusIcon aria-hidden="true" />{statusLabel}</div>
                {folderLabel && <div className="bridge-device-card__folder" title={device.report.root || undefined}>{folderLabel}</div>}
            </div>
            <Dropdown disabled={!verified || busy} trigger={['click']} placement="bottomRight" menu={{ items: [{ key: 'revoke', label: 'Отозвать доступ', danger: true, disabled: !verified || busy, onClick: onRevoke }] }}>
                <Button type="text" icon={<MoreOutlined />} loading={disconnecting} disabled={!verified || busy}
                    aria-label={`Действия с компьютером ${device.name}`} className="bridge-device-card__menu" />
            </Dropdown>
        </div>
        <div className="bridge-device-card__footer">
            <details className="bridge-device-card__details"><summary>Подробнее <DownOutlined aria-hidden="true" /></summary>
                <BridgeDeviceDetails device={device} />
            </details>
            {selected ? <span className="bridge-device-card__selected"><CheckOutlined aria-hidden="true" />Выбран</span>
                : <Button size="small" disabled={!verified || busy} aria-label={`Выбрать компьютер ${device.name}`} onClick={onChoose}>Выбрать</Button>}
        </div>
    </article>;
}
