import {SendOutlined, StopOutlined} from '@ant-design/icons';
import {Button, Input, Mentions, Typography} from 'antd';
import {useRef} from 'react';
import {FileDropZone} from '../../common/components/FileDropZone/FileDropZone';
import {CHAT_FILE_ACCEPT} from './files';
import {chatRecipients} from './participants';
import type {IModelChatParticipant} from './types';

interface Props {draft: string; disabled: boolean; canSend: boolean; sending: boolean; uploading: boolean; onDraft: (value: string) => void; onSend: () => void; onStop: () => void; onCancelUpload: () => void; onFiles: (files: File[]) => void; onReject: (message: string) => void; participants?: IModelChatParticipant[];}

export function ChatComposer(props: Props): JSX.Element {
    const composing = useRef(false);
    const targets = props.participants ? chatRecipients(props.draft, props.participants) : undefined;
    const enter = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        if (event.defaultPrevented) return;
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {event.preventDefault(); if (props.canSend && !targets?.error) props.onSend();}
    };
    const input = {id: 'model-chat-message', value: props.draft, autoSize: {minRows: 2, maxRows: 6}, disabled: props.disabled,
        onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => {const files = Array.from(event.clipboardData.files); if (files.length) props.onFiles(files);},
        onCompositionStart: () => {composing.current = true;}, onCompositionEnd: () => {composing.current = false;}};
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
        <label htmlFor="model-chat-message" className="model-chat__label">{props.participants ? 'Сообщение участникам' : 'Сообщение модели'}</label>
        {props.participants ? <Mentions {...input} placeholder="Сообщение всем участникам или @имя для отдельных агентов…" onChange={props.onDraft} onPressEnter={enter} placement="top"
            options={props.participants.filter(agent => agent.status === 'active').map(agent => ({value: agent.slug, label: `${agent.name} · @${agent.slug}`}))}
            filterOption={(search, option) => `${option.value} ${props.participants?.find(agent => agent.slug === option.value)?.name ?? ''}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))}/>
            : <Input.TextArea {...input} placeholder="Задайте вопрос по документам или напишите сообщение…" onChange={event => props.onDraft(event.target.value)} onKeyDown={enter}/>}
        {targets && <Typography.Text type={targets.error ? 'warning' : 'secondary'} className="model-chat__recipients" role="status">{targets.error || (targets.ids.length ? `Получат: ${props.participants!.filter(agent => targets.ids.includes(agent.agentId)).map(agent => agent.name).join(', ')}` : 'Получат все участники группы · @имя — выбрать адресатов')}</Typography.Text>}
        <div className="model-chat__composer-actions"><Typography.Text type="secondary">Enter — отправить · Shift+Enter — новая строка</Typography.Text>
            {props.sending ? <Button icon={<StopOutlined/>} onClick={props.onStop}>Остановить</Button> : props.uploading ? <Button onClick={props.onCancelUpload}>Отменить загрузку</Button> : <Button type="primary" icon={<SendOutlined/>} disabled={!props.canSend || !!targets?.error} onClick={props.onSend}>Отправить</Button>}</div>
    </div>;
}
