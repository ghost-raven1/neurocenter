import { Alert, Button, Typography } from 'antd';
import { ProjectTextKnowledge } from '../../ProjectTextKnowledge/ProjectTextKnowledge';
import { ChatToolPopover } from '../ChatToolPopover';
import type { IChatTextContextProps } from './interfaces';
import './ChatTextContext.less';

/** Search and explicit selection reuse the text corpus UI; opening never sends a chat message. */
export function ChatTextContext({
    projectId,
    value,
    disabled,
    conflicting,
    onUseTextContext,
    open,
    onOpenChange,
}: IChatTextContextProps) {
    if (!projectId) return null;
    return (
        <div className="chat-text-context">
            <ChatToolPopover label="Текстовая база проекта" open={open} onOpenChange={onOpenChange} disabled={disabled}>
                <Typography.Paragraph>
                    Найдите источники и выберите их для следующего сообщения. Текстовый поиск не использует
                    embedding-модель.
                </Typography.Paragraph>
                {conflicting && (
                    <Alert
                        type="warning"
                        message="Выберите один режим: текстовая база, исследование или инструменты агентов."
                        action={
                            <Button disabled={disabled || !value.availability.enabled} onClick={onUseTextContext}>
                                Перейти к текстовому контексту
                            </Button>
                        }
                    />
                )}
                {open && (
                    <ProjectTextKnowledge
                        key={value.identity}
                        projectId={projectId}
                        onSelectContext={
                            disabled || conflicting
                                ? undefined
                                : (selection) => {
                                      value.select(selection);
                                      onOpenChange(false);
                                  }
                        }
                    />
                )}
            </ChatToolPopover>
            {value.selection && (
                <div className="chat-text-context__selection" role="status">
                    <Typography.Text>
                        Текстовый контекст · ревизия {value.selection.revision} · запрос «{value.selection.query}»
                    </Typography.Text>
                    <Button type="link" size="small" disabled={disabled} onClick={value.clear}>
                        Убрать текстовый контекст
                    </Button>
                    {conflicting && (
                        <Alert
                            type="warning"
                            message="Текстовый контекст несовместим с исследованием или инструментами агентов. Уберите один из режимов."
                        />
                    )}
                    {!value.availability.enabled && (
                        <Alert
                            type="warning"
                            message="Текстовый режим выключен. Выбор сохранён; уберите его для обычного сообщения."
                        />
                    )}
                </div>
            )}
        </div>
    );
}
