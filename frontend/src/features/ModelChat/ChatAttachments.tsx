import {DeleteOutlined, FileTextOutlined, ReloadOutlined} from '@ant-design/icons';
import {Button, Spin, Typography} from 'antd';
import {chatFileError, chatFileSize} from './files';
import type {IChatUpload, IModelChatAttachment} from './types';
import {FeatureButton} from '../FeatureFlags/FeatureAvailability';
import {ChatDocumentIcon} from '../ChatCommon/ChatDocumentIcon';

interface Props {files: IModelChatAttachment[]; uploads: IChatUpload[]; disabled: boolean; onPreview: (id: string) => void; onRemove: (id: string) => void; onRetryUpload: (id: string) => void; onRemoveUpload: (id: string) => void;}
export function ChatAttachments({files, uploads, disabled, onPreview, onRemove, onRetryUpload, onRemoveUpload}: Props): JSX.Element {
    return <ul className="model-chat__attachments" aria-label="Вложения нового сообщения">
        {files.map(file => <li key={file.id}><ChatDocumentIcon name={file.name}/><div className="model-chat__attachment-text"><Button type="link" onClick={() => onPreview(file.id)}>{file.name}</Button>
            <Typography.Text type="secondary">{chatFileSize(file.bytes)} · текст извлечён{file.pages ? ` · страниц: ${file.pages}` : ''}</Typography.Text>
            {file.warning && <Typography.Text type="warning">{file.warning}</Typography.Text>}</div>
            <Button type="text" danger icon={<DeleteOutlined/>} disabled={disabled} aria-label={`Удалить вложение ${file.name}`} onClick={() => onRemove(file.id)}/>
        </li>)}
        {uploads.map(file => <li key={file.id}>{file.state === 'uploading' ? <Spin size="small"/> : <FileTextOutlined aria-hidden="true"/>}<div className="model-chat__attachment-text"><Typography.Text>{file.name}</Typography.Text>
            <Typography.Text type={file.state === 'failed' ? 'danger' : 'secondary'}>{file.state === 'uploading' ? 'Загружаем и извлекаем текст…' : file.error}</Typography.Text></div>
            {file.state === 'failed' && <><FeatureButton features={['model_chat']} type="text" icon={<ReloadOutlined/>} disabled={disabled || !!chatFileError(file.file)} aria-label={`Повторить загрузку ${file.name}`} onClick={() => onRetryUpload(file.id)}/>
                <Button type="text" danger icon={<DeleteOutlined/>} disabled={disabled} aria-label={`Убрать файл ${file.name}`} onClick={() => onRemoveUpload(file.id)}/></>}
        </li>)}
    </ul>;
}
