import {
    Alert,
    Button,
    Collapse,
    Select,
    Space,
    Spin,
    Typography,
} from 'antd';
import { useRef, useState, type FC } from 'react';
import {useHistory} from 'react-router-dom';
import { useBridge } from './useBridge';
import { bridgeConnectionState } from './bridgeRead';
import { PairingCode } from './PairingCode';
import { connectionBlocker } from './readiness';
import { BridgeDevicesManager } from './BridgeDevicesManager';
import { BridgeDeviceDetails } from './BridgeDeviceDetails';
import { bridgeDeviceStatus } from './bridgeDevicePresentation';
import {projectBindingUrl} from '../../modules/Projects/projectNavigation';
import './BridgeConnection.less';

/** Однократное подтверждение подключения и явный выбор компьютера для дальнейших установок. */
export const BridgeConnection: FC<{
    bridge: ReturnType<typeof useBridge>;
    compact?: boolean;
    showReadinessNotice?: boolean;
    projectId?: string;
}> = ({ bridge, compact, showReadinessNotice = true, projectId }) => {
    const { choose, errors, devicesReady, loading } = bridge;
    const [managementOpen, setManagementOpen] = useState(false);
    const [revokedIds, setRevokedIds] = useState<string[]>([]);
    const latestBridge = useRef(bridge);
    latestBridge.current = bridge;
    const devices = bridge.devices.filter(item => !revokedIds.includes(item.id));
    const device = bridge.device && !revokedIds.includes(bridge.device.id) ? bridge.device : undefined;
    const connection = bridgeConnectionState(devices.length, devicesReady, errors.devices);
    const readErrors = Object.values(errors).filter(Boolean);
    const history=useHistory();
    const setupUrl=projectId?projectBindingUrl(projectId):'/start?setup=1';
    const blocker = connectionBlocker(device);
    const statusUnverified = !devicesReady || !!errors.devices;
    return (
        <Space direction="vertical" className="bridge-connection" style={{ width: '100%' }}>
            <Space wrap className="bridge-connection__controls">
                {!compact && <Typography.Text strong>Компьютер</Typography.Text>}
                {devices.length > 0 ? (
                    <Select
                        aria-label="Компьютер для установки"
                        value={device?.id}
                        placeholder="Выберите компьютер"
                        onChange={choose}
                        disabled={statusUnverified}
                        className="bridge-connection__device-select"
                        options={devices.map(item => {
                            const status = bridgeDeviceStatus(item, !statusUnverified);
                            const label = `${item.name} · ${status}`;
                            return { value: item.id, title: label, label: <span className="bridge-connection__device-option" title={label}>
                                <span className="bridge-connection__device-name">{item.name}</span>
                                <span className="bridge-connection__device-status">{status}</span>
                            </span> };
                        })}
                    />
                ) : connection === 'loading' ? <Space><Spin size="small" /><Typography.Text type="secondary" role="status">Проверяем подключение…</Typography.Text></Space>
                    : <Typography.Text type="secondary" style={{overflowWrap:'anywhere'}}>
                        {connection === 'error' ? 'Подключение пока не проверено' : 'Компьютер пока не подключён'}
                    </Typography.Text>}
                {(!compact || readErrors.length > 0) && (
                    <Button
                        loading={loading}
                        onClick={() => {
                            void bridge.reload();
                        }}
                    >
                        Обновить данные
                    </Button>
                )}
                <Button onClick={() => setManagementOpen(true)}>Мои компьютеры ({devices.length})</Button>
            </Space>
            {device && !compact && <Collapse ghost><Collapse.Panel key="details" header="Сведения о выбранном компьютере">
                <BridgeDeviceDetails device={device} />
                <Typography.Text type="secondary">Фоновый мост работает независимо от окна OpenCode.</Typography.Text>
            </Collapse.Panel></Collapse>}
            <BridgeDevicesManager open={managementOpen} devices={devices} selectedId={device?.id} verified={!statusUnverified} loading={loading}
                onClose={() => setManagementOpen(false)} onChoose={choose} onReload={bridge.reload}
                onConnect={() => { setManagementOpen(false); history.push(setupUrl+'&addComputer=1'); }}
                onRevoked={async id => {
                    const current = latestBridge.current;
                    setRevokedIds(previous => [...previous, id]);
                    if (current.device?.id === id) { current.choose(current.devices.find(item => item.id !== id && !revokedIds.includes(item.id))?.id || ''); }
                    await current.reload();
                }} />
            {connection === 'empty' && (
                <>
                    <Alert type="info" showIcon message="Подключите этот компьютер"
                        description="Подключите уже установленный мост или установите его на новом компьютере. После подтверждения вы сможете выбрать папку проектов."
                        action={<Button type="primary" onClick={()=>history.push(setupUrl)}>Подключить компьютер</Button>}/>
                    <Collapse ghost><Collapse.Panel key="manual" header="Страница не открылась? Ввести код вручную"><PairingCode/></Collapse.Panel></Collapse>
                </>
            )}
            {device?.report.rootError&&<Alert type="warning" showIcon message={device.report.rootError}/>}
            {device?.report.bindings?.some(binding => binding.identityStatus === 'legacy') && <Alert type="warning" showIcon message="Есть старая привязка папки. На странице «Проекты» откройте мастер и подтвердите её после проверки файлов." />}
            {device?.report.bindings?.some(binding => binding.valid === false && binding.identityStatus !== 'legacy') && <Alert type="warning" showIcon message="Некоторые папки проектов перемещены или не подтверждены. Откройте мастер на странице «Проекты» для проверки копии или переноса." />}
            {!!device?.report.previousDeviceCompletions && <Alert type="warning" showIcon message="Есть неподтверждённые операции прежнего подключения. Локальные файлы сохранены; проверьте их перед повторной установкой." />}
            {showReadinessNotice && !statusUnverified && blocker && <Alert type="warning" showIcon message={blocker}
                action={history.location.pathname === '/start' ? undefined : <Button onClick={() => history.push(setupUrl)}>Начало работы</Button>} />}
            {readErrors.length > 0 && <Alert type="warning" showIcon
                message={readErrors.length === 1 ? readErrors[0] : 'Не все данные удалось загрузить'}
                description={readErrors.length > 1 ? <ul style={{margin:0,paddingLeft:20}}>{readErrors.map(text => <li key={text}>{text}</li>)}</ul> : undefined}
            />}
        </Space>
    );
};
