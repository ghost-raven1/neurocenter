import {SendOutlined} from '@ant-design/icons';
import {Button} from 'antd';
export interface ChatComposerAction {label: string; disabled: boolean; busy: boolean; onClick: () => void;}

/** Every chat uses the same primary action while its existing owner controls admission and receipts. */
export function ChatSendAction({task, label = 'Отправить', disabled, busy, onSend}: {task?: ChatComposerAction; label?: string; disabled?: boolean; busy?: boolean; onSend: () => void}): JSX.Element {
    return <Button type="primary" icon={<SendOutlined aria-hidden/>} loading={task?.busy ?? busy} disabled={task ? task.disabled : disabled} onClick={task?.onClick ?? onSend}>{task?.label ?? label}</Button>;
}
