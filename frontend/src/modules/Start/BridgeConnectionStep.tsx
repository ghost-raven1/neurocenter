import {Alert,Button,Collapse,Radio,Space,Typography} from 'antd';
import {useState} from 'react';
import type {useBridge} from '../../features/McpBridge/useBridge';
import type {IBridgeInstaller} from '../../features/McpBridge/useBridgeInstaller';
import {BridgeInstallerCommand} from '../../features/McpBridge/BridgeInstallerCommand';
import {InstalledBridgeConnect} from '../../features/McpBridge/InstalledBridgeConnect';
import {PairingCode} from '../../features/McpBridge/PairingCode';
import {BridgeSourcePanel} from '../../features/McpBridge/BridgeSourcePanel';
import {bridgeDeviceTarget} from '../../features/McpBridge/bridgeSource';

/** The first stage bootstraps only the bridge; later actions use the selected live computer. */
export function BridgeConnectionStep({bridge,installer,enabled,canManage,onCopy,onContinue}:{
    bridge:ReturnType<typeof useBridge>;installer:IBridgeInstaller;enabled:boolean;canManage:boolean;onCopy:(value:string)=>void;onContinue:()=>void;
}):JSX.Element {
    const {device}=bridge,connected=bridge.devicesReady&&!bridge.errors.devices&&!!device?.online&&!device.requiresReconnect;
    const [platform,setPlatform]=useState<'windows'|'posix'>(),windows=platform?platform==='windows':device?device.report.platform==='win32':/Windows/i.test(navigator.userAgent);
    const [archiveOpen,setArchiveOpen]=useState(false),[reconnect,setReconnect]=useState(false),[installRequested,setInstallRequested]=useState(false);
    return <Space direction="vertical" size={16} style={{width:'100%'}}>
        <Typography.Title level={3}>Подключите мост</Typography.Title>
        {connected&&!installRequested?<>
            <Typography.Paragraph>Компьютер подключён. Далее проверьте OpenCode или установите его через мост.</Typography.Paragraph>
            <Button type="primary" onClick={onContinue}>К OpenCode</Button>
        </>:<>
            <Typography.Paragraph>Выполните команду на нужном компьютере и подтвердите подключение в открывшемся окне. Пакет моста уже содержит свой Node.js.</Typography.Paragraph>
            {bridge.errors.devices&&<Alert type="warning" showIcon message={bridge.errors.devices}/>}
            <Radio.Group aria-label="Система компьютера для установки моста" value={windows?'windows':'posix'} onChange={event=>setPlatform(event.target.value)}
                options={[{value:'posix',label:'macOS / Linux'},{value:'windows',label:'Windows · PowerShell'}]}/>
            {enabled&&<BridgeInstallerCommand installer={installer} windows={windows} target={platform?undefined:bridgeDeviceTarget(device)} reconnect={!!device?.requiresReconnect} onCopy={onCopy}/>}
            <Button type="primary" loading={bridge.loading} onClick={()=>{void bridge.reload();}}>Проверить подключение</Button>
            {!!device&&!device.online&&<Typography.Text type="secondary">Подключение сохранено. Оставьте компьютер включённым и запустите установленный мост.</Typography.Text>}
            {connected&&installRequested&&<Button type="link" onClick={()=>setInstallRequested(false)}>Вернуться к настройке</Button>}
        </>}
        <Collapse ghost className="start__computer-options">
            <Collapse.Panel key="recovery" header="Другой компьютер или восстановление подключения">
                <Space direction="vertical" size={12} style={{width:'100%'}}>
                    <Button disabled={!enabled} onClick={()=>setReconnect(value=>!value)}>Подключить установленный мост</Button>
                    {reconnect&&enabled&&<InstalledBridgeConnect installer={installer} windows={windows} reconnect={!!device?.requiresReconnect} onCopy={onCopy}/>}
                    <PairingCode/>
                </Space>
            </Collapse.Panel>
            <Collapse.Panel key="source" header="Источник и локальный архив">
                <BridgeSourcePanel installer={installer} device={device} verified={bridge.devicesReady&&!bridge.errors.devices} windows={windows} canManage={canManage}
                    archiveOpen={archiveOpen} onArchiveChange={setArchiveOpen} onCopy={onCopy} onInstall={()=>{setReconnect(false);setInstallRequested(true);}}/>
            </Collapse.Panel>
        </Collapse>
    </Space>;
}
