import {Alert,Button,Input,Modal,Select,Space,Typography} from 'antd';
import {useState} from 'react';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {bridgeArchiveTargets,localBridgeArchiveCommand,type IBridgeArchiveSupply} from './bridgeArchive';
import {useBridgeArchive} from './useBridgeArchive';
import type {IBridgeInstaller} from './useBridgeInstaller';

/** Downloading and installing local files is separate from later pairing with a live server. */
export function BridgeArchiveInstall({installer,supply,windows,onClose,onRefresh,onCopy}:{installer:IBridgeInstaller;supply?:IBridgeArchiveSupply;windows:boolean;onClose:()=>void;onRefresh:()=>void;onCopy?:(text:string)=>void}) {
    const {scope,captureOwner}=useAuthRequestOwner();
    const [selection,setSelection]=useState<{scope:string;target?:string;path?:string}>({scope}),[copyError,setCopyError]=useState('');
    const selected=selection.scope===scope?selection:{scope};
    const ready=!!installer.origin&&!installer.loading&&!installer.error;
    const targets=ready?bridgeArchiveTargets(supply):[];
    const target=targets.includes(selected.target??'')?selected.target:undefined;
    const metadata=useBridgeArchive(ready?installer.origin:undefined,supply,target);
    const archive=metadata.archive,scriptWindows=target?target.startsWith('windows-'):windows;
    const localPath=selected.path??archive?.file??'';
    let command='';try{command=localBridgeArchiveCommand(localPath,scriptWindows);}catch{/* A local filename must be supplied before a copyable command exists. */}
    const copy=async()=>{
        const owns=captureOwner();if(!owns()||!command)return;
        setCopyError('');
        if(onCopy){onCopy(command);return;}
        try{await navigator.clipboard.writeText(command);}catch{if(owns())setCopyError('Не удалось скопировать. Выделите команду и скопируйте вручную.');}
    };
    return <Modal open centered title="Из локального архива" width={720} footer={<Button onClick={onClose}>Закрыть</Button>} onCancel={onClose}>
        <Space direction="vertical" size={16} style={{width:'100%'}}>
            <Typography.Paragraph>Новая установка из архива выполняется без подключения к серверу. Заранее сохраните три файла в одну папку: архив, его файл .sha256 и установщик этой площадки. Загружать архив на сайт не нужно. Системные Node.js и npm не нужны.</Typography.Paragraph>
            <Typography.Text strong>Скачать пакет для нужного компьютера</Typography.Text>
            {targets.length?<Select aria-label="Система архива моста" style={{width:'100%'}} value={target} placeholder="Выберите ОС, архитектуру и libc" options={targets.map(value=>({value,label:value}))}
                onChange={value=>{if(captureOwner()())setSelection({...selected,target:value});}}/>:<Alert type="info" showIcon message={installer.loading?'Загружаем список пакетов…':'Список пакетов сейчас недоступен. Уже доставленный архив можно установить ниже.'} action={<Button onClick={onRefresh}>Обновить список пакетов</Button>}/>}
            <Typography.Text type="secondary">Выберите систему целевого компьютера. Браузер может быть открыт на другом устройстве.</Typography.Text>
            {metadata.loading&&<Typography.Text role="status">Проверяем метаданные архива…</Typography.Text>}
            {metadata.error&&<Alert type="warning" showIcon message={metadata.error} action={<Button onClick={metadata.reload}>Повторить загрузку архива</Button>}/>}
            {archive&&<>
                <Typography.Text>{archive.version} · {archive.target} · {archive.bytes} байт</Typography.Text>
                <Typography.Text code>Сборка: {archive.buildId}</Typography.Text><Typography.Text code>SHA-256: {archive.sha256}</Typography.Text>
                <Space wrap><Typography.Link href={`${archive.origin}/api/bridge/runtime/${archive.file}?download=1`} download={archive.file} target="_blank" rel="noopener noreferrer">Скачать архив</Typography.Link>
                    <Typography.Link href={`${archive.origin}/api/bridge/runtime/${archive.file}.sha256?download=1`} download={`${archive.file}.sha256`} target="_blank" rel="noopener noreferrer">Сохранить .sha256</Typography.Link>
                    <Typography.Link href={`${archive.origin}/api/bridge/install.${scriptWindows?'ps1':'sh'}?version=${archive.version}&download=1`} download={`install.${scriptWindows?'ps1':'sh'}`} target="_blank" rel="noopener noreferrer">Сохранить установщик</Typography.Link></Space>
                <Typography.Text type="secondary">Сохраните файлы по ссылкам, не меняя имён. SHA-256 скачанного файла проверит локальный установщик; браузер не подтверждает результат установки.</Typography.Text>
            </>}
            <Typography.Text strong>Архив уже доставлен</Typography.Text>
            <Typography.Paragraph>Откройте терминал в папке с тремя файлами. Укажите точное имя или путь архива; файл контрольной суммы должен называться так же, с окончанием .sha256.</Typography.Paragraph>
            <Input aria-label="Локальный архив моста" value={localPath} onChange={event=>{if(captureOwner()())setSelection({...selected,path:event.target.value});}} placeholder="Например, ./bridge.tgz" maxLength={4096}/>
            {command&&<div className="start__command"><code>{command}</code><Button onClick={()=>{void copy();}}>Копировать локальную команду</Button></div>}
            {!!localPath&&!command&&<Typography.Text type="warning">Укажите непустой путь к архиву без управляющих символов, до 4096 знаков.</Typography.Text>}
            {copyError&&<Typography.Text type="warning">{copyError}</Typography.Text>}
            <Typography.Paragraph type="secondary">Установщик зарегистрирует мост и сохранит настройки OpenCode. Автоматического подключения и открытия браузера в этом режиме нет. Когда сервер станет доступен, закройте это окно и выберите «Мост уже установлен».</Typography.Paragraph>
            <Typography.Text type="secondary">Обновлению работающего подключённого моста может понадобиться связь с прежним сервером для безопасной паузы. При отказе прежняя установка сохраняется.</Typography.Text>
        </Space>
    </Modal>;
}
