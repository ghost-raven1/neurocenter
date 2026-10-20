import { LaptopOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Modal, Skeleton, Typography } from 'antd';
import { useRef, useState } from 'react';
import { bridgeApi, type IBridgeDevice } from './api';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { BridgeDeviceCard } from './BridgeDeviceCard';
import './BridgeDevicesManager.less';

interface BridgeDevicesManagerProps {
    open: boolean;
    devices: IBridgeDevice[];
    selectedId?: string;
    verified: boolean;
    loading: boolean;
    onClose: () => void;
    onChoose: (id: string) => void;
    onConnect: () => void;
    onReload: () => Promise<void>;
    onRevoked: (id: string) => Promise<void>;
}

/** Управляет своими компьютерами; поздний отзыв согласует список, сохраняя текущего владельца и выбор. */
export function BridgeDevicesManager({ open, devices, selectedId, verified, loading, onClose, onChoose, onConnect, onReload, onRevoked }: BridgeDevicesManagerProps) {
    const { scope, captureOwner } = useAuthRequestOwner();
    const latest = useRef({ open, onRevoked, view: 0 });
    latest.current = { open, onRevoked, view: latest.current.view + (latest.current.open === open ? 0 : 1) };
    const view = latest.current.view;
    const [operation, setOperation] = useState({ scope, view, disconnecting: '', error: '', owns: undefined as (() => boolean) | undefined });
    const [confirmation, setConfirmation] = useState<{ scope: string; view: number; device: IBridgeDevice; owns: () => boolean }>();
    const pendingRevoke = useRef<(() => boolean) | undefined>();
    const disconnecting = operation.scope === scope && operation.owns?.() ? operation.disconnecting : '';
    const error = operation.scope === scope && operation.view === view && operation.owns?.() ? operation.error : '';
    const confirming = confirmation?.scope === scope && confirmation.view === view && confirmation.owns() ? confirmation.device : undefined;
    const revoke = async (device: IBridgeDevice): Promise<void> => {
        const currentOwner = captureOwner();
        if (!currentOwner() || pendingRevoke.current?.()) { return; }
        pendingRevoke.current = currentOwner;
        const currentView = () => currentOwner() && latest.current.open && latest.current.view === view;
        setOperation({ scope, view, disconnecting: device.id, error: '', owns: currentOwner });
        try {
            await bridgeApi.revoke(device.id);
            if (currentOwner()) { await latest.current.onRevoked(device.id); }
        } catch (cause) {
            if (currentView()) { setOperation({ scope, view, disconnecting: '', error: errorMessage(cause, 'Не удалось отозвать доступ компьютера.'), owns: currentOwner }); }
        } finally {
            if (pendingRevoke.current === currentOwner) { pendingRevoke.current = undefined; }
            if (currentOwner()) { setOperation(previous => ({ ...previous, disconnecting: '' })); }
        }
    };
    return <>
        <Modal open={open} centered width={720} onCancel={onClose} className="bridge-computers"
            title={<div className="bridge-computers__heading">
                <div><span>Мои компьютеры</span><p>Выберите, где работать с проектами.</p></div>
                <Button type="text" icon={<ReloadOutlined />} loading={loading} disabled={!!disconnecting}
                    aria-label="Обновить список компьютеров" onClick={() => { void onReload(); }}>Обновить</Button>
            </div>}
            footer={<div className="bridge-computers__footer">
                <Button onClick={onClose}>Готово</Button>
                <Button type="primary" onClick={onConnect}>Подключить компьютер</Button>
            </div>}>
            {error && <Alert type="error" showIcon message={error} className="bridge-computers__notice" />}
            {!verified && !loading && <Alert type="warning" showIcon className="bridge-computers__notice"
                message={devices.length ? 'Статусы пока не подтверждены' : 'Не удалось загрузить компьютеры'}
                description="Обновите список, чтобы проверить подключение." />}
            {loading && !devices.length ? <div className="bridge-computers__loading" role="status" aria-label="Загружаем компьютеры">
                <Skeleton active avatar title paragraph={{ rows: 2 }} />
            </div> : devices.length ? <div className="bridge-computers__list">
                {devices.map(device => <BridgeDeviceCard key={device.id} device={device} selected={selectedId === device.id}
                    verified={verified} busy={!!disconnecting} disconnecting={disconnecting === device.id}
                    folderLabel={devices.some(other => other.id !== device.id && other.name === device.name) && device.report.root
                        ? device.report.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : undefined}
                    onChoose={() => onChoose(device.id)} onRevoke={() => {
                        const owns = captureOwner();
                        if (owns()) { setConfirmation({ scope, view, device, owns }); }
                    }} />)}
            </div> : verified && <div className="bridge-computers__empty">
                <div className="bridge-computers__empty-icon" aria-hidden="true"><LaptopOutlined /></div>
                <h3>Подключите первый компьютер</h3>
                <Typography.Paragraph type="secondary">После подключения здесь появятся его статус и доступные действия.</Typography.Paragraph>
            </div>}
        </Modal>
        <Modal open={open && !!confirming} centered width={440} className="bridge-computers-confirm"
            title="Отозвать доступ компьютера?" okText="Отозвать доступ" cancelText="Отмена" okButtonProps={{ danger: true }}
            onCancel={() => setConfirmation(undefined)} onOk={() => {
                if (!confirming || !captureOwner()()) { return; }
                setConfirmation(undefined);
                return revoke(confirming);
            }}>
            <Typography.Paragraph><strong>{confirming?.name}</strong> исчезнет из списка, а ожидающие задания будут отменены.</Typography.Paragraph>
            {confirming?.report.root && <Typography.Paragraph type="secondary">Папка: {confirming.report.root}</Typography.Paragraph>}
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>Локальные файлы и история сохранятся. Чтобы вернуть компьютер, подключите мост заново.</Typography.Paragraph>
        </Modal>
    </>;
}
