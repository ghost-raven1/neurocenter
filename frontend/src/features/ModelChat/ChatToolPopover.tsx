import {CloseOutlined} from '@ant-design/icons';
import {Button, Popover} from 'antd';
import {useEffect, useRef, type ReactNode} from 'react';

interface Props {label: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode; disabled?: boolean;}

/** Secondary composer tools float above the input and never resize the conversation. */
export function ChatToolPopover({label, open, onOpenChange, children, disabled}: Props): JSX.Element {
    const trigger = useRef<HTMLButtonElement>(null), visible = useRef(open); visible.current = open;
    const close = (): void => {
        onOpenChange(false); const source = trigger.current;
        if (source?.isConnected) (source.disabled ? source.closest('.ant-modal-content')?.querySelector<HTMLButtonElement>('.model-chat__composer-actions button:not([disabled])') : source)?.focus();
    };
    const escape = (event: React.KeyboardEvent<HTMLElement>): void => {
        if (!visible.current || event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); close();
    };
    return <Popover trigger="click" placement="topRight" open={open} onOpenChange={onOpenChange} destroyTooltipOnHide
        overlayClassName="model-chat-tool-popover" autoAdjustOverflow={{adjustX: 1, adjustY: 0}}
        getPopupContainer={element => element.closest<HTMLElement>('.ant-modal-content') ?? element.parentElement ?? document.body}
        content={<ToolPanel label={label} open={open} onEscape={escape}>
            <div className="model-chat-tool-popover__heading"><strong>{label}</strong><Button type="text" size="small" icon={<CloseOutlined/>} aria-label={`Закрыть: ${label}`} onClick={close}/></div>
            <div className="model-chat-tool-popover__body">{children}</div>
        </ToolPanel>}>
        <Button ref={trigger} type="text" size="small" className="model-chat__tool-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onKeyDown={escape}>{label}</Button>
    </Popover>;
}

/** rc-util restores its portal after StrictMode cleanup; focus follows that synchronous replay. */
function ToolPanel({label, open, onEscape, children}: {label: string; open: boolean; onEscape: (event: React.KeyboardEvent<HTMLElement>) => void; children: ReactNode}): JSX.Element {
    const panel = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let current = true;
        if (open) queueMicrotask(() => {if (current && panel.current?.isConnected) panel.current.focus();});
        return () => {current = false;};
    }, [open]);
    return <div ref={panel} className="model-chat-tool-popover__panel" role="dialog" aria-label={label} tabIndex={-1} onKeyDown={onEscape}>{children}</div>;
}
