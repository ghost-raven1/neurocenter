import type { IBridgeDevice } from './api';
import { bridgeLastSeen } from './bridgeDevicePresentation';

/** Технические сведения доступны по запросу и не занимают место в рабочем сценарии. */
export function BridgeDeviceDetails({ device }: { device: IBridgeDevice }) {
    const lastSeen = bridgeLastSeen(device.lastSeen);
    return <dl className="bridge-device-details">
        <div><dt>Общая папка</dt><dd>{device.report.root || 'Папка проектов ещё не выбрана'}</dd></div>
        <div><dt>Версия</dt><dd>{device.report.bridgeVersion ? `версия моста: ${device.report.bridgeVersion}` : 'версия моста не передана'}</dd></div>
        <div><dt>Доступ моста</dt><dd>{device.role}</dd></div>
        <div><dt>Последний ответ моста:</dt><dd>{lastSeen
            ? <time dateTime={lastSeen.toISOString()}>{lastSeen.toLocaleString('ru-RU')}</time>
            : 'Ответов моста ещё нет'}</dd></div>
    </dl>;
}
