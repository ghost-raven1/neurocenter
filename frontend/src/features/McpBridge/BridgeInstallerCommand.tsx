import {Alert,Button,Typography} from 'antd';
import {CopyOutlined} from '@ant-design/icons';
import type {IBridgeInstaller} from './useBridgeInstaller';
import {bridgeInstallerCommand,openCodeInstallerCommand} from './connectionCommands';

/** Команду можно скопировать только после получения проверенного адреса Gateway. */
export function BridgeInstallerCommand({installer,windows,reconnect=false,openCode=false,onCopy}:{
    installer:IBridgeInstaller;windows:boolean;reconnect?:boolean;openCode?:boolean;onCopy(text:string):void;
}) {
    if(installer.loading){return <Typography.Text role="status">Получаем адрес установщика…</Typography.Text>;}
    if(!installer.origin){return <Alert type="error" showIcon message={installer.error}
        action={<Button onClick={installer.reload}>Повторить загрузку</Button>}/>;}
    const command=openCode?openCodeInstallerCommand(installer.origin,windows):bridgeInstallerCommand(installer.origin,windows,reconnect);
    return <div className="start__command"><code>{command}</code><Button icon={<CopyOutlined/>} onClick={()=>onCopy(command)}>Копировать команду</Button></div>;
}
