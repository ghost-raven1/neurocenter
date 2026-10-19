import {
    Alert,
    Button,
    Collapse,
    Popconfirm,
    Select,
    Space,
    Spin,
    Typography,
} from 'antd';
import { useState, type FC } from 'react';
import {useHistory} from 'react-router-dom';
import { useBridge } from './useBridge';
import { bridgeApi } from './api';
import { errorMessage } from '../../common/utils/errorMessage';
import { bridgeConnectionState } from './bridgeRead';
import { PairingCode } from './PairingCode';
import { connectionBlocker } from './readiness';
import './BridgeConnection.less';

/** Однократное подтверждение подключения и явный выбор компьютера для дальнейших установок. */
export const BridgeConnection: FC<{
    bridge: ReturnType<typeof useBridge>;
    compact?: boolean;
}> = ({ bridge, compact }) => {
    const { devices, device, choose, errors, devicesReady, loading } = bridge;
    const connection = bridgeConnectionState(devices.length, devicesReady, errors.devices);
    const readErrors = Object.values(errors).filter(Boolean);
    const [disconnectError, setDisconnectError] = useState('');
    const history=useHistory();
    const blocker = connectionBlocker(device);
    return (
        <Space direction="vertical" className="bridge-connection" style={{ width: '100%' }}>
            <Space wrap className="bridge-connection__controls">
                <Typography.Text strong>Мост</Typography.Text>
                {devices.length > 0 ? (
                    <Select
                        aria-label="Компьютер для установки"
                        value={device?.id}
                        placeholder="Выберите компьютер"
                        onChange={choose}
                        disabled={!!errors.devices}
                        className="bridge-connection__device-select"
                        options={devices.map((item) => ({
                            value: item.id,
                            label: `${item.name} · ${item.online ? 'на связи' : 'не в сети'}`,
                        }))}
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
                {!compact && device && (
                    <Popconfirm
                        title={`Отключить мост «${device.name}» от вашего профиля?`}
                        okText="Отключить"
                        cancelText="Отмена"
                        onConfirm={async () => {
                            try {
                                await bridgeApi.revoke(device.id);
                                setDisconnectError('');
                                await bridge.reload();
                            } catch (cause) {
                                setDisconnectError(
                                    errorMessage(
                                        cause,
                                        'Не удалось отключить мост.',
                                    ),
                                );
                            }
                        }}
                    >
                        <Button danger disabled={!devicesReady}>Отключить мост</Button>
                    </Popconfirm>
                )}
            </Space>
            {device && (
                <Typography.Text type="secondary">
                    {device.report.root || 'Папка проектов ещё не выбрана'} ·
                    роль моста: {device.role}
                    {device.report.bridgeVersion ? ` · версия моста: ${device.report.bridgeVersion}` : ' · версия моста не передана'}
                    {!device.online
                        ? ' · задания останутся в очереди до подключения моста'
                        : ''}
                </Typography.Text>
            )}
            {connection === 'empty' && (
                <>
                    <Alert type="info" showIcon message="Подключите этот компьютер"
                        description="Установщик откроет страницу подтверждения. После подключения вы сможете выбрать папку проектов."
                        action={<Button type="primary" onClick={()=>history.push('/start?step=1')}>Подключить компьютер</Button>}/>
                    <Collapse ghost><Collapse.Panel key="manual" header="Страница не открылась? Ввести код вручную"><PairingCode/></Collapse.Panel></Collapse>
                </>
            )}
            {device?.report.rootError&&<Alert type="warning" showIcon message={device.report.rootError}/>}
            {device?.report.bindings?.some(binding => binding.identityStatus === 'legacy') && <Alert type="warning" showIcon message="Есть старая привязка папки. На странице «Проекты» откройте мастер и подтвердите её после проверки файлов." />}
            {device?.report.bindings?.some(binding => binding.valid === false && binding.identityStatus !== 'legacy') && <Alert type="warning" showIcon message="Некоторые папки проектов перемещены или не подтверждены. Откройте мастер на странице «Проекты» для проверки копии или переноса." />}
            {!!device?.report.previousDeviceCompletions && <Alert type="warning" showIcon message="Есть неподтверждённые операции прежнего подключения. Локальные файлы сохранены; проверьте их перед повторной установкой." />}
            {blocker && <Alert type="warning" showIcon message={blocker}
                action={history.location.pathname === '/start' ? undefined : <Button onClick={() => history.push('/start?step=1')}>Начало работы</Button>} />}
            {readErrors.length > 0 && <Alert type="warning" showIcon
                message={readErrors.length === 1 ? readErrors[0] : 'Не все данные удалось загрузить'}
                description={readErrors.length > 1 ? <ul style={{margin:0,paddingLeft:20}}>{readErrors.map(text => <li key={text}>{text}</li>)}</ul> : undefined}
            />}
            {disconnectError && (
                <Alert type="error" showIcon message={disconnectError} />
            )}
        </Space>
    );
};
