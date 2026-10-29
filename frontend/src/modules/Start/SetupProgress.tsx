import {Descriptions,Tag,Typography} from 'antd';
import type {useBridge} from '../../features/McpBridge/useBridge';
import type {ReactNode} from 'react';

/** Верхняя сводка показывает выбранный компьютер; детали проекта остаются на своих шагах. */
export function SetupProgress({bridge,cli}:{bridge:ReturnType<typeof useBridge>;cli?:ReactNode}){
    const device=bridge.device,verified=bridge.devicesReady&&!bridge.errors.devices;
    return <section aria-label="Состояние настройки окружения">
        <Descriptions size="small" column={1}>
            <Descriptions.Item label="Компьютер">{device?<>
                <Typography.Text strong>{device.name}</Typography.Text>{' '}
                <Tag color={verified&&device.online?'green':'orange'}>{!verified?'Статус не подтверждён':device.online?'На связи':'Не в сети'}</Tag>
                <Typography.Text type="secondary">{device.report.bridgeVersion?`${verified&&device.online?'Мост':'Последний отчёт: мост'} ${device.report.bridgeVersion}`:'Версия моста не передана'}</Typography.Text>
            </>:<Typography.Text>{verified?'Подключите мост и выберите компьютер':'Статус подключения не подтверждён'}</Typography.Text>}</Descriptions.Item>
            {device&&cli&&<Descriptions.Item label="OpenCode">{cli}</Descriptions.Item>}
        </Descriptions>
    </section>;
}
