import {CodeOutlined, DownOutlined, LaptopOutlined} from '@ant-design/icons';
import {Alert, Button, Popover, Select, Space} from 'antd';
import {useEffect, useId, useRef, useState} from 'react';
import {bridgeDeviceTarget, compareBridgeVersions} from '../McpBridge/bridgeSource';
import {bridgeDeviceStatus} from '../McpBridge/bridgeDevicePresentation';
import {CliObservationDetails} from './CliObservation';
import {useComputerEnvironment} from './ComputerEnvironment';
import {cliObservationPresentation} from './presentation';
import {SetupProgress} from './SetupProgress';
import './ComputerHeader.less';

/** Persistent compact status; detailed recovery and version checks open on demand. */
export function ComputerHeader({onSetup}: {onSetup: () => void}): JSX.Element {
    const {bridge, installer, cli} = useComputerEnvironment();
    const [open, setOpen] = useState(false), id = useId();
    const trigger = useRef<HTMLButtonElement>(null), content = useRef<HTMLElement>(null);
    const device = bridge.device, verified = bridge.devicesReady && !bridge.errors.devices;
    const connected = !!device && verified && device.online && !device.requiresReconnect;
    const {label, observation, running} = cliObservationPresentation(cli.state);
    const supply = installer.devSupply, target = bridgeDeviceTarget(device);
    const update = !!supply && !!target && supply.targets.includes(target) && compareBridgeVersions(device?.report.bridgeVersion, supply.version) === -1;
    useEffect(() => {
        if (!open) return;
        const timer = window.setTimeout(() => content.current?.focus({preventScroll: true}), 0);
        return () => window.clearTimeout(timer);
    }, [open]);
    const close = () => {setOpen(false); trigger.current?.focus({preventScroll: true});};
    const setup = () => {setOpen(false); onSetup();};
    const details = <section id={id} ref={content} tabIndex={-1} className="computer-header__details" aria-label="Сведения о компьютере и OpenCode"
        onKeyDown={event => {if (event.key === 'Escape') {event.stopPropagation(); close();}}}>
        {bridge.devices.length > 1 && <Select aria-label="Компьютер рабочего пространства" value={device?.id} disabled={!bridge.devicesReady} placeholder="Выберите компьютер"
            options={bridge.devices.map(item => ({value: item.id, label: item.name}))} onChange={bridge.choose} style={{width: '100%'}}/>}
        <SetupProgress bridge={bridge} cli={<CliObservationDetails control={cli}/>}/>
        {(bridge.errors.devices || device?.report.rootError) && <Alert type="warning" showIcon message={bridge.errors.devices || device?.report.rootError}/>}
        {update && <Alert type="info" showIcon message={`Доступен мост ${supply!.version}`} action={<Button size="small" onClick={setup}>Обновить мост</Button>}/>}
        <Space className="computer-header__actions" size={[8, 8]} wrap>
            <Button size="small" loading={bridge.loading} onClick={() => {void bridge.reload();}}>Проверить подключение</Button>
            <Button size="small" onClick={setup}>{device ? 'Настройка компьютера' : 'Подключить компьютер'}</Button>
        </Space>
    </section>;
    return <Popover content={details} open={open} onOpenChange={setOpen} trigger="click" placement="bottomRight">
        <Button ref={trigger} type="text" className="computer-header__trigger" aria-expanded={open} aria-controls={id}
            aria-label={`Компьютер и OpenCode: ${device?.name ?? 'компьютер не выбран'}, ${device ? label : 'версия не проверена'}`}>
            <LaptopOutlined aria-hidden="true"/>
            <span className="computer-header__identity"><span className="computer-header__name">{device?.name ?? 'Компьютер не выбран'}</span>
                <span className={`computer-header__status${connected ? ' computer-header__status_online' : ''}`}>
                    {device ? `${bridgeDeviceStatus(device, !!verified)}${device.report.bridgeVersion ? ` · ${device.report.bridgeVersion}` : ''}` : 'Подключите мост'}
                </span>
            </span>
            <span className="computer-header__divider" aria-hidden="true"/>
            <CodeOutlined aria-hidden="true" spin={running}/>
            <span className="computer-header__cli"><span>{device ? label : 'OpenCode'}</span>
                {observation && <time dateTime={observation.checkedAt}>{new Date(observation.checkedAt).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'})}</time>}
            </span>
            <DownOutlined aria-hidden="true"/>
        </Button>
    </Popover>;
}
