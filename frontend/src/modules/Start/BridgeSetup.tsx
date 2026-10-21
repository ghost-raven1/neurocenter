import {Alert,Button,Collapse,Radio,Select,Space,Typography} from 'antd';
import {useHistory} from 'react-router-dom';
import {useEffect,useState} from 'react';
import {useBridge} from '../../features/McpBridge/useBridge';
import {BridgeConnection} from '../../features/McpBridge/BridgeConnection';
import {InstalledBridgeConnect} from '../../features/McpBridge/InstalledBridgeConnect';
import {PairingCode} from '../../features/McpBridge/PairingCode';
import {awaitingBridgeReport,bridgeOperationBlocker} from '../../features/McpBridge/readiness';
import {roleLevel} from '../../features/UserBlock/roles';
import {BridgeInstallerCommand} from '../../features/McpBridge/BridgeInstallerCommand';
import type {IBridgeInstaller} from '../../features/McpBridge/useBridgeInstaller';
import {projectBindingUrl} from '../Projects/projectNavigation';

type ConnectionAction = 'connect'|'install';

/** Существующий мост подключается отдельно; установка нужна при отсутствии или обновлении программы. */
export const BridgeSetup=({origin,installer,windows:browserWindows,onCopy,projectId}:{origin:string;installer:IBridgeInstaller;windows:boolean;onCopy:(text:string)=>void;projectId?:string})=>{
    const bridge=useBridge();const history=useHistory();
    const connectionRequested=new URLSearchParams(history.location.search).get('addComputer')==='1';
    const [installerPanels,setInstallerPanels]=useState<string[]|undefined>();
    const [action,setAction]=useState<ConnectionAction>();
    const [platform,setPlatform]=useState<'windows'|'posix'>();
    const {device}=bridge;
    const windows=platform?platform==='windows':device?.report.platform?device.report.platform==='win32':browserWindows;
    const needsReconnect=!!device&&(!!device.requiresReconnect||roleLevel(device.role)<2);
    const awaitingFirstReport=awaitingBridgeReport(device);
    const needsUpdate=!!device&&!awaitingFirstReport&&(device.report.protocolVersion!==2||
        ['durable-completions','managed-installations','install-set-v1','workspace-instance-v1'].some(capability=>!device.report.capabilities?.includes(capability)));
    const folderBlocked=!!bridgeOperationBlocker(device);
    const preservesConnection=!!device&&!needsReconnect;
    const currentAction=action??(connectionRequested?'connect':needsUpdate&&!needsReconnect?'install':'connect');
    const healthy=bridge.devicesReady&&!!device?.online&&!needsReconnect&&!needsUpdate;
    useEffect(()=>{
        if(connectionRequested){setInstallerPanels(['another']);setAction('connect');}
    },[connectionRequested,history.location]);
    const installation=<>
        <Typography.Paragraph>{preservesConnection?'Выполните команду в терминале этого компьютера. Установщик установит доступную на этой площадке сборку моста.':'Выполните команду на компьютере, где будете работать. Установщик сам откроет страницу подтверждения в браузере.'}</Typography.Paragraph>
        <BridgeInstallerCommand installer={installer} windows={windows} reconnect={needsReconnect} onCopy={onCopy}/>
        <Alert type="info" showIcon message={preservesConnection?'Перезапустите OpenCode после обновления':'Следующий шаг — подтвердить компьютер'}
            description={preservesConnection?'Сохранённое подключение будет использовано повторно. Файлы и история установок сохраняются. Затем нажмите «Проверить подключение», чтобы увидеть версию работающего моста.':'На открывшейся странице проверьте имя компьютера и нажмите «Подключить компьютер». Затем дождитесь статуса «На связи». Вводить код обычно не требуется.'}/>
        <Typography.Paragraph type="secondary" style={{marginTop:12}}>Готовый пакет содержит Node.js и зависимости моста. Устанавливать npm не требуется. Существующие настройки OpenCode сохраняются.</Typography.Paragraph>
    </>;
    const connection=<Space direction="vertical" size={16} style={{width:'100%'}}>
        <Radio.Group className="start__connection-method" aria-label="Способ подключения моста" value={currentAction} onChange={event=>setAction(event.target.value as ConnectionAction)}>
            <Radio.Button value="connect">Мост уже установлен</Radio.Button>
            <Radio.Button value="install">{needsUpdate?'Обновить мост':'Установить мост'}</Radio.Button>
        </Radio.Group>
        <Space wrap><Typography.Text>Система компьютера</Typography.Text><Select aria-label="Система компьютера" style={{width:200,maxWidth:'100%'}} value={windows?'windows':'posix'} onChange={setPlatform}
            options={[{value:'posix',label:'macOS / Linux'},{value:'windows',label:'Windows (PowerShell)'}]}/></Space>
        {currentAction==='connect'?<InstalledBridgeConnect origin={origin} windows={windows}
            reconnect={needsReconnect||(bridge.devicesReady&&bridge.devices.length===0)} onCopy={onCopy}/>:installation}
        <Collapse ghost><Collapse.Panel key="manual" header="Есть код подключения? Ввести вручную"><PairingCode/></Collapse.Panel></Collapse>
    </Space>;
    return <Space direction="vertical" size={16} style={{width:'100%'}}>
        <Typography.Title level={3} style={{margin:0}}>Подключение компьютера</Typography.Title>
        {bridge.devices.length>0?<>
            <BridgeConnection bridge={bridge} compact showReadinessNotice={false}/>
            {!healthy&&<Alert type="warning" showIcon
                message={!bridge.devicesReady?'Не удалось обновить статус':!device?'Выберите компьютер':needsReconnect?'Подтвердите подключение заново':awaitingFirstReport?'Ожидаем первого выхода на связь':needsUpdate?'Обновите мост':device.online?`${device.name} — на связи`:'Компьютер подключён, но сейчас не отвечает'}
                description={!bridge.devicesReady?'Текущий статус моста не подтверждён. Обновите данные, чтобы проверить соединение. Сохранённое подключение не требует повторной установки.':!device?'У вас несколько подключений. Выберите компьютер, на котором будете работать.':needsReconnect
                    ?roleLevel(device.role)<2?'Для изменения проектов выберите на сайте назначенную вам роль разработчика или администратора и подтвердите подключение. Переустановка моста для этого не нужна.':'Продлите подключение установленного моста и подтвердите доступ в браузере. Файлы и история сохранятся.'
                    :awaitingFirstReport?'Доступ подтверждён. Запустите установленный мост командой подключения и нажмите «Проверить подключение». Его версия появится после первого ответа.'
                    :needsUpdate?'Для новых возможностей обновите программу командой ниже. Установщик сохранит файлы и историю.':'Запустите установленный мост командой подключения. Повторная установка обычно не нужна.'}/>}
            {healthy&&<Typography.Text type="secondary">Мост работает в фоне. Перейдите к папке проекта.</Typography.Text>}
            <Space wrap>
                <Button type="primary" disabled={folderBlocked||!bridge.devicesReady||!device?.online} onClick={()=>history.push(device?.report.root&&projectId?projectBindingUrl(projectId):'/projects')}>{device?.report.root?'Связать папку проекта':'Выбрать папку проектов'}</Button>
                <Button loading={bridge.loading} onClick={()=>{void bridge.reload();}}>Проверить подключение</Button>
            </Space>
            <Collapse ghost activeKey={installerPanels??(connectionRequested||needsUpdate||needsReconnect||!device?.online?['another']:[])} onChange={keys=>setInstallerPanels(Array.isArray(keys)?keys:[keys])}>
                <Collapse.Panel key="another" header={needsUpdate&&!needsReconnect?'Обновление моста':'Подключение и обновление моста'}>{connection}</Collapse.Panel>
            </Collapse>
        </>:<>
            {bridge.loading?<Typography.Text role="status">Проверяем подключения в вашем профиле…</Typography.Text>:null}
            {bridge.errors.devices&&<Alert type="warning" showIcon message={bridge.errors.devices} action={<Button onClick={()=>{void bridge.reload();}}>Повторить</Button>}/>}
            {bridge.devicesReady&&<>{connection}<Button loading={bridge.loading} onClick={()=>{void bridge.reload();}}>Проверить подключение</Button></>}
        </>}
    </Space>;
};
