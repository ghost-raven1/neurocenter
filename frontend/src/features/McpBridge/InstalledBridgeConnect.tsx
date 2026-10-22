import {CopyOutlined} from '@ant-design/icons';
import {Alert,Button,Typography} from 'antd';
import {installedBridgeCommand} from './connectionCommands';
import type {IBridgeInstaller} from './useBridgeInstaller';

/** Запуск установленного моста отделён от установки и обновления его файлов. */
export function InstalledBridgeConnect({installer,windows,reconnect,onCopy}:{installer:IBridgeInstaller;windows:boolean;reconnect:boolean;onCopy(text:string):void}) {
    if(installer.loading){return <Typography.Text role="status">Получаем адрес подключения…</Typography.Text>;}
    if(installer.error||!installer.origin){return <Alert type="error" showIcon message={installer.error||'Не удалось получить настройки подключения из API Gateway.'}
        action={<Button onClick={installer.reload}>Повторить загрузку</Button>}/>;}
    const command = installedBridgeCommand(installer.origin,windows,reconnect);
    return <>
        <Typography.Paragraph>Выполните команду на нужном компьютере. Сценарий этой площадки использует встроенный Node.js установленного моста: короткая команда запуска, системные Node.js и npm не нужны. При наличии готовой установки архив повторно не скачивается.</Typography.Paragraph>
        <div className="start__command"><code>{command}</code><Button icon={<CopyOutlined/>} onClick={()=>onCopy(command)}>Копировать команду подключения</Button></div>
        <Alert type="info" showIcon message={reconnect?'Подтвердите подключение в этом профиле':'Проверьте подключение компьютера'}
            description={reconnect?'Откроется страница подтверждения. Сверьте имя и отпечаток компьютера, затем подтвердите доступ.':'Действующее подключение сохранится. Если нужно подтверждение, мост откроет страницу в браузере.'}/>
        <Typography.Paragraph type="secondary" style={{marginTop:12}}>После запуска нажмите «Проверить подключение». Если файлы моста отсутствуют, сценарий сам запустит установщик этой площадки. При ошибке подключения сначала устраните причину, показанную в терминале.</Typography.Paragraph>
    </>;
}
