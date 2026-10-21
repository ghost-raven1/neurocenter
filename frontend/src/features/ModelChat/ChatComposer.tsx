import {SendOutlined, StopOutlined} from '@ant-design/icons';
import {Button, Input, Typography} from 'antd';
import {useRef} from 'react';
import {FileDropZone} from '../../common/components/FileDropZone/FileDropZone';
import {CHAT_FILE_ACCEPT} from './files';

interface Props {draft: string; disabled: boolean; canSend: boolean; sending: boolean; uploading: boolean; onDraft: (value: string) => void; onSend: () => void; onStop: () => void; onCancelUpload: () => void; onFiles: (files: File[]) => void; onReject: (message: string) => void;}

export function ChatComposer(props: Props): JSX.Element {
    const composing = useRef(false);
    return <div className="model-chat__composer" onDragOver={event => {if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();}}
        onDrop={event => {
            if (!Array.from(event.dataTransfer.types).includes('Files')) return;
            event.preventDefault(); event.stopPropagation(); if (props.disabled) return;
            try {
                if (Array.from(event.dataTransfer.items).some(item => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory)) {props.onReject('Прикрепите файлы, а не папку.'); return;}
                const files = Array.from(event.dataTransfer.files); if (files.length) props.onFiles(files);
            } catch {props.onReject('Не удалось прочитать файлы. Выберите их кнопкой.');}
        }}>
        <details className="model-chat__file-picker"><summary>Прикрепить документы</summary><FileDropZone label="Документы для чата" title="Перетащите документы сюда" buttonText="Выбрать файлы"
            hint="PDF, DOCX, текст, CSV и исходный код · до 5 файлов по 10 МиБ · до 100 КиБ извлечённого текста в файле · сканы и изображения пока не поддерживаются" accept={CHAT_FILE_ACCEPT} multiple disabled={props.disabled} busy={props.uploading} onFiles={props.onFiles} onReject={props.onReject}/></details>
        <label htmlFor="model-chat-message" className="model-chat__label">Сообщение модели</label>
        <Input.TextArea id="model-chat-message" value={props.draft} autoSize={{minRows: 2, maxRows: 6}} placeholder="Задайте вопрос по документам или напишите сообщение…" disabled={props.disabled}
            onChange={event => props.onDraft(event.target.value)} onPaste={event => {const files = Array.from(event.clipboardData.files); if (files.length) props.onFiles(files);}}
            onCompositionStart={() => {composing.current = true;}} onCompositionEnd={() => {composing.current = false;}}
            onKeyDown={event => {if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {event.preventDefault(); if (props.canSend) props.onSend();}}}/>
        <div className="model-chat__composer-actions"><Typography.Text type="secondary">Enter — отправить · Shift+Enter — новая строка</Typography.Text>
            {props.sending ? <Button icon={<StopOutlined/>} onClick={props.onStop}>Остановить</Button> : props.uploading ? <Button onClick={props.onCancelUpload}>Отменить загрузку</Button> : <Button type="primary" icon={<SendOutlined/>} disabled={!props.canSend} onClick={props.onSend}>Отправить</Button>}</div>
    </div>;
}
