import {Alert,Modal,Progress,Space,Typography} from 'antd';
import {useEffect,useState} from 'react';
import {ASSET_ARCHIVE_ACCEPT} from './archiveUpload';
import type {useAssetArchiveUpload} from './useAssetArchiveUpload';

/** Verification imports source descriptions and files; catalogue cards are still selected explicitly. */
export function AssetArchiveModal({open,onClose,upload,blocked}:{open:boolean;onClose:()=>void;upload:ReturnType<typeof useAssetArchiveUpload>;blocked:boolean}) {
    const [file,setFile]=useState<File>(),[error,setError]=useState('');
    useEffect(()=>{if(!open){setFile(undefined);setError('');}},[open]);
    const close=():void=>{upload.cancel();onClose();};
    return <Modal open={open} title="Импортировать архив" onCancel={close} destroyOnClose maskClosable={!upload.busy}
        okText="Загрузить и проверить" cancelText={upload.busy?'Отменить загрузку':'Закрыть'} confirmLoading={upload.busy}
        okButtonProps={{disabled:!file||blocked||upload.busy}} onOk={()=>{if(file&&!blocked)void upload.upload(file);}}>
        <Space direction="vertical" className="asset-sources__content">
            <Typography.Paragraph>Выберите ZIP, TAR, TAR.GZ или TGZ до 8 ГиБ. Карточки появятся после проверки архива; затем выберите, что добавить в общий каталог.</Typography.Paragraph>
            <Typography.Paragraph type="secondary">Обычный Download ZIP с GitHub содержит описания: скиллы и агенты с файлами внутри описания могут быть готовы сразу. Для MCP, плагинов и локальных моделей нужна подготовленная поставка с бинарными файлами. Из архива сетевой дозагрузки нет.</Typography.Paragraph>
            <input className="ant-input" type="file" aria-label="Архив ассетов" accept={ASSET_ARCHIVE_ACCEPT} disabled={upload.busy||blocked} onChange={event=>{
                const files=event.target.files;setFile(undefined);setError('');
                if(files?.length===1)setFile(files[0]);else if(files?.length)setError('Выберите один архив за одну загрузку.');
                event.target.value='';
            }}/>
            {file&&<Typography.Text>{file.name}</Typography.Text>}
            {(error||upload.error)&&<Alert type="error" showIcon message={error||upload.error}/>}
            {upload.busy&&<><Typography.Text role="status">{upload.stage==='validating'?'Архив передан. Сервер проверяет описи и файлы…':'Загружаем архив…'}</Typography.Text><Progress percent={upload.percent} status="active"/></>}
        </Space>
    </Modal>;
}
