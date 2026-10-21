import { Button, Divider, Space, Spin, Tag, Typography } from 'antd';
import { FileZipOutlined, FolderOpenOutlined, UploadOutlined } from '@ant-design/icons';
import { type FC, useRef, useState } from 'react';
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
    const archive = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);
    const selection = (input: HTMLInputElement, fromArchive = false): void => {
        if (input.files?.length) onSelect(Array.from(input.files), fromArchive);
        input.value = '';
    };

    return <div className="tool-packaging__files">
        <div className={`tool-packaging__drop${dragging ? ' tool-packaging__drop--active' : ''}${disabled ? ' tool-packaging__drop--disabled' : ''}${uploaded ? ' tool-packaging__drop--selected' : ''}`}
            role="group" aria-label="Загрузка архива" aria-disabled={disabled} aria-busy={reading}
            onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; if (!disabled) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => { event.preventDefault(); setDragging(false); if (!disabled) onSelect(Array.from(event.dataTransfer.files), true); }}>
            <div className="tool-packaging__drop-icon" aria-hidden="true">{reading ? <Spin /> : <FileZipOutlined />}</div>
            <div className="tool-packaging__drop-copy">
                <Text strong>{reading ? 'Проверяем исходники…' : dragging ? 'Отпустите архив здесь' : uploaded ? 'Заменить исходники' : 'Перетащите архив сюда'}</Text>
                <Text type="secondary">{reading ? 'Подготавливаем исходники к сборке' : uploaded ? 'Перетащите новый архив' : 'или выберите его на компьютере'}</Text>
            </div>
            <Button icon={<UploadOutlined />} disabled={disabled} onClick={() => archive.current?.click()}>Выбрать архив</Button>
            <Text type="secondary" className="tool-packaging__formats">ZIP · TAR · TAR.GZ · TGZ<span>до 8 МБ</span></Text>
        </div>
        <Divider plain className="tool-packaging__or">или выберите исходники</Divider>
        <Space wrap className="tool-packaging__file-actions">
            <Button icon={<FolderOpenOutlined />} disabled={disabled} onClick={() => folder.current?.click()}>Выбрать папку</Button>
            <Button icon={<UploadOutlined />} disabled={disabled} onClick={() => files.current?.click()}>Выбрать файлы</Button>
        </Space>
        <input ref={element => { folder.current = element; element?.setAttribute('webkitdirectory', ''); }} type="file" multiple className="tool-packaging__file" onChange={event => selection(event.currentTarget)} />
        <input ref={files} type="file" multiple className="tool-packaging__file" onChange={event => selection(event.currentTarget)} />
        <input ref={archive} type="file" accept=".zip,.tar,.tar.gz,.tgz" aria-label="Архив исходников" className="tool-packaging__file" onChange={event => selection(event.currentTarget, true)} />
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
