import {Alert,Button,Collapse,Space,Typography} from 'antd';
import {CopyOutlined} from '@ant-design/icons';
import {useHistory} from 'react-router-dom';
import {useState} from 'react';
import {useBridge} from '../../features/McpBridge/useBridge';
import {BridgeConnection} from '../../features/McpBridge/BridgeConnection';
import {PairingCode} from '../../features/McpBridge/PairingCode';
import { bridgeOperationBlocker, installationBlocker } from '../../features/McpBridge/readiness';
import { roleLevel } from '../../features/UserBlock/roles';

/** Подключённое устройство видно сразу; ручной код остаётся резервным способом. */
export const BridgeSetup=({command,onCopy}:{command:string;onCopy:(text:string)=>void})=>{
    const bridge=useBridge();const history=useHistory();
    const [installerPanels,setInstallerPanels]=useState<string[]|undefined>();
    const needsUpdate = !!bridge.device && (!!installationBlocker(bridge.device) || !bridge.device.report.capabilities?.includes('workspace-instance-v1'));
    const folderBlocked = !!bridgeOperationBlocker(bridge.device);
    const preservesConnection = !!bridge.device && !bridge.device.requiresReconnect && roleLevel(bridge.device.role) >= 2;
    const installCommand = bridge.device && roleLevel(bridge.device.role) < 2 ? command.replace(/install\.(sh|ps1)/, '$&?reconnect=1') : command;
    const installation=<>
        <Typography.Paragraph>{preservesConnection?'Выполните команду в терминале этого компьютера. Установщик установит доступную на этой площадке сборку моста.':'Выполните команду на компьютере, где будете работать. Установщик сам откроет страницу подтверждения в браузере.'}</Typography.Paragraph>
        <div className="start__command"><code>{installCommand}</code><Button icon={<CopyOutlined/>} onClick={()=>onCopy(installCommand)}>Копировать команду</Button></div>
        <Alert type="info" showIcon message={preservesConnection?'Перезапустите OpenCode после обновления':'Следующий шаг — подтвердить компьютер'}
            description={preservesConnection?'Сохранённое подключение будет использовано повторно. Файлы и история установок сохраняются. Затем нажмите «Проверить подключение», чтобы увидеть версию работающего моста.':'На открывшейся странице проверьте имя компьютера и нажмите «Подключить компьютер». Затем дождитесь статуса «На связи». Вводить код обычно не требуется.'}/>
        <Typography.Paragraph type="secondary" style={{marginTop:12}}>Готовый пакет содержит Node.js и зависимости моста. Устанавливать npm не требуется. Существующие настройки OpenCode сохраняются.</Typography.Paragraph>
    </>;
    return <Space direction="vertical" size={16} style={{width:'100%'}}>
        <Typography.Title level={3} style={{margin:0}}>Подключение компьютера</Typography.Title>
        {bridge.devices.length>0?<>
            <Alert type={!needsUpdate&&bridge.devicesReady&&bridge.device?.online?'success':'warning'} showIcon
                message={!bridge.devicesReady?'Не удалось обновить статус':!bridge.device?'Выберите компьютер':bridge.device.requiresReconnect?'Нужно продлить подключение компьютера':needsUpdate?'Обновите или переподключите мост':bridge.device.online?`${bridge.device.name} — на связи`:'Компьютер подключён, но сейчас не отвечает'}
                description={!bridge.device?'У вас несколько подключений. Выберите компьютер, на котором будете работать.':needsUpdate?'Выполните команду ниже. Установщик сохранит файлы и историю, а при необходимости откроет подтверждение подключения.':bridge.device.online?'Мост уже установлен. Следующий шаг — выбрать общую папку и связать проект.':'Включите компьютер и проверьте соединение. Повторная установка обычно не нужна.'}/>
            <Space wrap>
                <Button type="primary" disabled={folderBlocked||!bridge.devicesReady||!bridge.device?.online} onClick={()=>history.push('/projects')}>{bridge.device?.report.root?'Связать папку проекта':'Выбрать папку проектов'}</Button>
                <Button loading={bridge.loading} onClick={()=>{void bridge.reload();}}>Проверить подключение</Button>
                <Button onClick={()=>setInstallerPanels(['another'])}>Обновить мост</Button>
            </Space>
            <BridgeConnection bridge={bridge} compact/>
            <Collapse ghost activeKey={installerPanels??(needsUpdate?['another']:[])} onChange={keys=>setInstallerPanels(Array.isArray(keys)?keys:[keys])}><Collapse.Panel key="another" header={needsUpdate?'Обновить или переподключить этот компьютер':'Установить или обновить мост'}>{installation}<Collapse ghost><Collapse.Panel key="manual" header="Браузер не открылся? Подключить вручную"><PairingCode/></Collapse.Panel></Collapse></Collapse.Panel></Collapse>
        </>:<>
            {bridge.loading?<Typography.Text role="status">Проверяем, подключён ли этот компьютер…</Typography.Text>:null}
            {bridge.errors.devices&&<Alert type="warning" showIcon message={bridge.errors.devices} action={<Button onClick={()=>{void bridge.reload();}}>Повторить</Button>}/>}
            {bridge.devicesReady&&<>
                {installation}
                <Collapse ghost><Collapse.Panel key="manual" header="Браузер не открылся? Подключить вручную"><PairingCode/></Collapse.Panel></Collapse>
            </>}
        </>}
    </Space>;
};
