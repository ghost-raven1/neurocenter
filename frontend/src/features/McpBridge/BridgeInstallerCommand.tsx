import {Alert,Button,Typography} from 'antd';
import {CopyOutlined} from '@ant-design/icons';
import type {IBridgeInstaller} from './useBridgeInstaller';
import {bridgeInstallerCommand,openCodeInstallerCommand} from './connectionCommands';
import {bridgeInstallerEligibility} from './bridgeInstallerEligibility';

/** Команду можно скопировать только после получения проверенного адреса Gateway. */
export function BridgeInstallerCommand({installer,windows,target,reconnect=false,openCode=false,onCopy}:{
    installer:IBridgeInstaller;windows:boolean;target?:string;reconnect?:boolean;openCode?:boolean;onCopy(text:string):void;
}) {
    if(installer.loading){return <Typography.Text role="status">Получаем адрес установщика…</Typography.Text>;}
    if(!installer.origin){return <Alert type="error" showIcon message={installer.error}
        action={<Button onClick={installer.reload}>Повторить загрузку</Button>}/>;}
    const eligibility=bridgeInstallerEligibility(installer.devSupply,windows,target);
    if(!eligibility.supported)return <Alert type="warning" showIcon message="В dev-поставке нет пакета для выбранной системы компьютера."
        description={`Доступные пакеты: ${installer.devSupply!.targets.join(', ')}.`}/>;
    const command=openCode?openCodeInstallerCommand(installer.origin,windows):bridgeInstallerCommand(installer.origin,windows,reconnect);
    return <>{installer.devSupply&&!eligibility.confirmed&&<Typography.Paragraph type="secondary">Архитектуру компьютера проверит установщик.</Typography.Paragraph>}
        <div className="start__command"><code>{command}</code><Button icon={<CopyOutlined/>} onClick={()=>onCopy(command)}>Копировать команду</Button></div></>;
}
