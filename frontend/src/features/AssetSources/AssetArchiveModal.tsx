import {Alert,Modal,Progress,Space,Typography} from 'antd';
import {useEffect,useState} from 'react';
import {ASSET_ARCHIVE_ACCEPT,assetArchiveError} from './archiveUpload';
import {FileDropZone} from '../../common/components/FileDropZone/FileDropZone';
import type {useAssetArchiveUpload} from './useAssetArchiveUpload';
import {FeatureAvailabilityNotice,useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {formatBytes} from '../../common/utils/format';

/** Verification imports source descriptions and files; catalogue cards are still selected explicitly. */
export function AssetArchiveModal({open,onClose,upload,blocked}:{open:boolean;onClose:()=>void;upload:ReturnType<typeof useAssetArchiveUpload>;blocked:boolean}) {
    const [file,setFile]=useState<File>(),[error,setError]=useState('');
    const availability=useFeatureAvailability('asset_sources');
    useEffect(()=>{if(!open){setFile(undefined);setError('');}},[open]);
    const close=():void=>{upload.cancel();onClose();};
    return <Modal open={open} centered bodyStyle={{maxHeight:'calc(100dvh - 180px)',overflowY:'auto'}} title="Импортировать архив" onCancel={close} destroyOnClose maskClosable={!upload.busy}
        okText="Загрузить и проверить" cancelText={upload.busy?'Отменить загрузку':'Закрыть'} confirmLoading={upload.busy}
        okButtonProps={{disabled:!file||!!error||blocked||upload.busy||!availability.enabled}} onOk={()=>{if(file&&!error&&!blocked&&!upload.busy&&availability.enabled)void upload.upload(file);}}>
        <FeatureAvailabilityNotice features={['asset_sources']}/>
        <Space direction="vertical" className="asset-sources__content">
            <Typography.Paragraph>Загрузите архив поставки ассетов с описью версий и готовыми файлами. После проверки выберите, что добавить в каталог.</Typography.Paragraph>
            <details className="asset-sources__archive-help">
                <summary>Какой архив нужен</summary>
                <Typography.Paragraph type="secondary">Архив с исходниками одного инструмента загружайте в каталоге через «Упаковать инструмент».</Typography.Paragraph>
                <Typography.Paragraph type="secondary">Обычный Download ZIP с GitHub содержит описания: скиллы и агенты с файлами внутри описания могут быть готовы сразу. Для MCP, плагинов и локальных моделей нужна подготовленная поставка с бинарными файлами. Из архива сетевой дозагрузки нет.</Typography.Paragraph>
            </details>
            <FileDropZone label="Архив ассетов" title="Перетащите архив сюда" buttonText="Выбрать архив" hint="Один ZIP, TAR, TAR.GZ или TGZ · до 8 ГиБ"
                accept={ASSET_ARCHIVE_ACCEPT} disabled={blocked||!availability.enabled} busy={upload.busy} onReject={setError} onFiles={files=>{
                    if(upload.busy||blocked||!availability.enabled)return;
                    const candidate=files[0];if(!candidate)return;
                    const invalid=assetArchiveError(candidate);setError(invalid);if(!invalid)setFile(candidate);
                }}/>
            {file&&<Typography.Text>{file.name} · {file.size<1000?file.size+' Б':formatBytes(file.size)}</Typography.Text>}
            {(error||upload.error)&&<Alert type="error" showIcon message={error||upload.error}/>}
            {upload.busy&&<><Typography.Text role="status">{upload.stage==='validating'?'Архив передан. Сервер проверяет описи и файлы…':'Загружаем архив…'}</Typography.Text><Progress percent={upload.percent} status="active"/></>}
        </Space>
    </Modal>;
}
