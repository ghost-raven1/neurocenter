import {StopOutlined} from '@ant-design/icons';
import {Button, Input, Mentions, Typography} from 'antd';
import {FileDropZone} from '../../common/components/FileDropZone/FileDropZone';
import {CHAT_FILE_ACCEPT} from './files';
import {chatRecipients} from './participants';
import type {IModelChatParticipant} from './types';
import {ChatToolPopover} from './ChatToolPopover';
import {chatSystemRoleMention, chatSystemRoleOptions} from '../ChatSystemRoles/mentions';
import type {SystemRoleId} from '../SystemRoles/types';
import type {ChatRoleAction} from '../ChatSystemRoles/types';
import {ChatSendAction} from '../ChatCommon/ChatSendAction';
import {useChatEnter} from '../ChatCommon/useChatEnter';

interface Props {draft: string; disabled: boolean; canSend: boolean; sending: boolean; uploading: boolean; onDraft: (value: string) => void; onSend: () => void; onStop: () => void; onCancelUpload: () => void; onFiles: (files: File[]) => void; onReject: (message: string) => void; participants?: IModelChatParticipant[]; filesOpen?: boolean; onFilesOpenChange?: (open: boolean) => void; onSystemRole?: (agentId: SystemRoleId, instruction: string) => void; systemTask?: boolean; systemAction?: ChatRoleAction; onCancelSystemTask?: () => void;}

export function ChatComposer(props: Props): JSX.Element {
    const role = props.onSystemRole ? chatSystemRoleMention(props.draft, props.participants) : undefined;
    const targets = props.participants && !props.systemTask && !role?.agentId && !role?.error ? chatRecipients(props.draft, props.participants) : undefined;
    const targetError = role?.error || targets?.error;
    const send = (): void => {if (props.systemTask) {if (!props.systemAction?.disabled) props.systemAction?.onClick(); return;} if (targetError) return; if (role?.agentId) props.onSystemRole?.(role.agentId, role.instruction); else props.onSend();};
    const keyboard = useChatEnter(() => {if (props.systemTask || props.canSend && !targetError) send();}), enter = keyboard.onPressEnter;
    const input = {id: 'model-chat-message', 'aria-describedby': `model-chat-keyboard-hint model-chat-context-status${targets ? ' model-chat-recipients' : ''}`, value: props.draft, autoSize: {minRows: 1, maxRows: 4}, disabled: props.disabled,
        onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => {const files = Array.from(event.clipboardData.files); if (files.length) props.onFiles(files);},
        onCompositionStart: keyboard.onCompositionStart, onCompositionEnd: keyboard.onCompositionEnd};
    return <div className="model-chat__composer" onDragOver={event => {if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();}}
        onDrop={event => {
            if (!Array.from(event.dataTransfer.types).includes('Files')) return;
            event.preventDefault(); event.stopPropagation(); if (props.disabled) return;
            try {
                if (Array.from(event.dataTransfer.items).some(item => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory)) {props.onReject('Прикрепите файлы, а не папку.'); return;}
                const files = Array.from(event.dataTransfer.files); if (files.length) props.onFiles(files);
            } catch {props.onReject('Не удалось прочитать файлы. Выберите их кнопкой.');}
        }}>
        <div className="model-chat__composer-heading"><label htmlFor="model-chat-message" className="model-chat__label">{props.systemTask ? 'Задача системному агенту' : 'Сообщение'}</label>
        {props.systemTask ? <Button type="text" size="small" disabled={props.systemAction?.busy} onClick={props.onCancelSystemTask}>Вернуться к сообщению</Button> : props.onSystemRole && <Button type="text" size="small" disabled={props.disabled} onClick={() => props.onSystemRole?.('agent-coordinator', props.draft)}>Системный агент</Button>}
        {targets && <Typography.Text id="model-chat-recipients" type={targets.error ? 'warning' : 'secondary'} className="model-chat__recipients" role="status">{targets.error || (targets.ids.length ? `Получат: ${props.participants!.filter(agent => targets.ids.includes(agent.agentId)).map(agent => agent.name).join(', ')}` : 'Команде')}</Typography.Text>}
        <div className="model-chat__file-picker"><ChatToolPopover label="Прикрепить документы" open={props.filesOpen ?? false} onOpenChange={props.onFilesOpenChange ?? (() => undefined)} disabled={props.disabled}>
            <FileDropZone label="Документы для чата" title="Перетащите документы сюда" buttonText="Выбрать файлы"
            hint="PDF, DOCX, текст, CSV и исходный код · до 5 файлов по 10 МиБ · до 100 КиБ извлечённого текста в файле · сканы и изображения пока не поддерживаются" accept={CHAT_FILE_ACCEPT} multiple disabled={props.disabled} busy={props.uploading} onFiles={props.onFiles} onReject={props.onReject}/>
        </ChatToolPopover></div>
        </div>
        {props.participants || props.onSystemRole ? <Mentions {...input} placeholder="Сообщение или @имя агента…" onChange={props.onDraft} onPressEnter={enter} placement="top"
            options={[...(props.participants ?? []).filter(agent => agent.status === 'active').map(agent => ({value: agent.slug, label: `${agent.name} · @${agent.slug}`})), ...(props.onSystemRole ? chatSystemRoleOptions : [])]}
            filterOption={(search, option) => `${option.value} ${chatSystemRoleOptions.find(role => role.value === option.value)?.label ?? ''} ${props.participants?.find(agent => agent.slug === option.value)?.name ?? ''}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))}/>
            : <Input.TextArea {...input} placeholder="Задайте вопрос по документам или напишите сообщение…" onChange={event => props.onDraft(event.target.value)} onKeyDown={enter}/>}
        {(props.systemTask || role?.agentId || role?.error) && <Typography.Text type={!props.systemTask && role?.error ? 'warning' : 'secondary'} role="status">{!props.systemTask && role?.error || 'Сначала проверим задачу, модель и контекст. Ничего не отправляется без вашего согласия.'}</Typography.Text>}
        <div className="model-chat__composer-actions"><Typography.Text id="model-chat-keyboard-hint" type="secondary" className="model-chat__keyboard-hint">Enter — отправить · Shift+Enter — новая строка</Typography.Text>
            {props.sending ? <Button icon={<StopOutlined/>} onClick={props.onStop}>Остановить</Button> : props.uploading ? <Button onClick={props.onCancelUpload}>Отменить загрузку</Button> : <ChatSendAction task={props.systemAction} label={props.systemTask ? 'Открываем задачу…' : role?.agentId ? 'Подготовить задачу' : 'Отправить'} disabled={props.systemTask || !props.canSend || !!targetError} onSend={send}/>}</div>
    </div>;
}
