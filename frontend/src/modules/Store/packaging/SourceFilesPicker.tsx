import { Alert, Button, Divider, Space, Tag, Typography } from 'antd';
import { FileZipOutlined, FolderOpenOutlined, UploadOutlined } from '@ant-design/icons';
import { type FC, useRef, useState } from 'react';
import {FileDropZone} from '../../../common/components/FileDropZone/FileDropZone';
import type { PackagingFilesResult } from './sourceFiles';

interface Props {
    disabled: boolean;
    reading: boolean;
    uploaded?: PackagingFilesResult;
    archiveName: string;
    onSelect: (files: readonly File[], fromArchive?: boolean) => void;
}
const { Text, Paragraph } = Typography;
const fileLabel = (count: number): string => {
    const form = new Intl.PluralRules('ru').select(count);
    return `${count} ${form === 'one' ? 'файл' : form === 'few' ? 'файла' : 'файлов'}`;
};

/** Архив и выбранная папка передают исходники в один процесс проверки и сборки. */
export const SourceFilesPicker: FC<Props> = ({ disabled, reading, uploaded, archiveName, onSelect }) => {
    const folder = useRef<HTMLInputElement | null>(null);
    const files = useRef<HTMLInputElement>(null);
    const [selectionError, setSelectionError] = useState('');
    const blocked=disabled||reading,locked=useRef(blocked);locked.current=blocked;
    const selection = (input: HTMLInputElement, fromArchive = false): void => {
        if (!locked.current&&input.files?.length) {setSelectionError('');onSelect(Array.from(input.files), fromArchive);}
        input.value = '';
    };

    return <div className="tool-packaging__files">
        <FileDropZone label="Архив исходников" title={reading?'Проверяем исходники…':uploaded?'Заменить исходники':'Перетащите архив сюда'}
            hint="ZIP · TAR · TAR.GZ · TGZ · до 8 МБ" buttonText="Выбрать архив" accept=".zip,.tar,.tar.gz,.tgz" disabled={blocked} busy={reading}
            onReject={message=>{if(!locked.current)setSelectionError(message);}} onFiles={files=>{if(locked.current||files.length!==1)return;setSelectionError('');onSelect(files,true);}}/>
        {selectionError&&<Alert type="error" showIcon message={selectionError}/>}
        <Divider plain className="tool-packaging__or">или выберите исходники</Divider>
        <Space wrap className="tool-packaging__file-actions">
            <Button icon={<FolderOpenOutlined />} disabled={blocked} onClick={() => folder.current?.click()}>Выбрать папку</Button>
            <Button icon={<UploadOutlined />} disabled={blocked} onClick={() => files.current?.click()}>Выбрать файлы</Button>
        </Space>
        <input ref={element => { folder.current = element; element?.setAttribute('webkitdirectory', ''); }} type="file" multiple disabled={blocked} className="tool-packaging__file" onChange={event => selection(event.currentTarget)} />
        <input ref={files} type="file" multiple disabled={blocked} className="tool-packaging__file" onChange={event => selection(event.currentTarget)} />
        <Paragraph type="secondary" className="tool-packaging__limits">До 100 файлов: 1 МБ на файл, 5 МБ всего. Исходники и SKILL.md — UTF-8; ресурсы скилла могут быть PNG, PDF и другими бинарными файлами. Зависимости, .git и файлы ключей пропускаются.</Paragraph>
        <div role="status" aria-live="polite">
            {reading && <Text type="secondary">Читаем файлы и проверяем содержимое…</Text>}
            {uploaded && <div className="tool-packaging__selection">
                <div className="tool-packaging__selection-icon" aria-hidden="true">{archiveName ? <FileZipOutlined /> : <FolderOpenOutlined />}</div>
                <div className="tool-packaging__selection-copy">
                    <Text strong className="tool-packaging__selection-name" title={archiveName || uploaded.rootName}>{archiveName || uploaded.rootName || 'Выбранные исходники'}</Text>
                    <Space wrap size={[8, 4]}><Text type="secondary">{fileLabel(uploaded.files.length)}</Text>{uploaded.skipped > 0 && <Tag>Пропущено: {uploaded.skipped}</Tag>}</Space>
                </div>
            </div>}
        </div>
    </div>;
};
