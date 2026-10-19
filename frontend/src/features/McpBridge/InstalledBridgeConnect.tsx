import {CopyOutlined} from '@ant-design/icons';
import {Alert,Button,Typography} from 'antd';
import {installedBridgeCommand} from './connectionCommands';

/** Запуск установленного моста отделён от установки и обновления его файлов. */
export function InstalledBridgeConnect({origin,windows,reconnect,onCopy}:{origin:string;windows:boolean;reconnect:boolean;onCopy(text:string):void}) {
    const command = installedBridgeCommand(origin,windows,reconnect);
    return <>
        <Typography.Paragraph>Выполните команду в терминале компьютера, который хотите подключить. Она запустит установленный мост без скачивания пакета и изменения настроек OpenCode.</Typography.Paragraph>
        <div className="start__command"><code>{command}</code><Button icon={<CopyOutlined/>} onClick={()=>onCopy(command)}>Копировать команду подключения</Button></div>
        <Alert type="info" showIcon message={reconnect?'Подтвердите подключение в этом профиле':'Проверьте подключение компьютера'}
            description={reconnect?'Откроется страница подтверждения. Сверьте имя и отпечаток компьютера, затем подтвердите доступ.':'Действующее подключение сохранится. Если нужно подтверждение, мост откроет страницу в браузере.'}/>
        <Typography.Paragraph type="secondary" style={{marginTop:12}}>После запуска нажмите «Проверить подключение». Если команда сообщает, что файл не найден, выберите «Установить мост». При нестандартном каталоге установки используйте путь к своему мосту.</Typography.Paragraph>
        <Typography.Paragraph type="secondary">Для перехода с другой площадки используйте установку или обновление: они также меняют адрес MCP в OpenCode.</Typography.Paragraph>
    </>;
}
