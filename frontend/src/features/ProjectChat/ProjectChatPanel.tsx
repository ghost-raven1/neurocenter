import {CloseOutlined} from '@ant-design/icons';
import {Button, Popover, Tooltip} from 'antd';
import {useEffect, useRef, type ReactNode} from 'react';

interface Props {
    label: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode;
    icon?: ReactNode; caption?: string; disabled?: boolean; placement?: 'topRight' | 'bottomRight';
}

/** Secondary panels keep their form mounted when folded, including an unsaved agent configuration. */
export function ProjectChatPanel({label, open, onOpenChange, children, icon, caption, disabled, placement = 'bottomRight'}: Props): JSX.Element {
    const trigger = useRef<HTMLButtonElement>(null);
    const close = (): void => {onOpenChange(false); if (trigger.current?.isConnected) trigger.current.focus();};
    const escape = (event: React.KeyboardEvent<HTMLElement>): void => {
        if (!open || event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); close();
    };
    return <Popover trigger="click" placement={placement} open={open} onOpenChange={onOpenChange} destroyTooltipOnHide={false}
        overlayClassName="project-chat-panel" autoAdjustOverflow={{adjustX: 1, adjustY: 0}}
        getPopupContainer={element => element.closest<HTMLElement>('.ant-modal-content') ?? element.parentElement ?? document.body}
        content={<PanelBody label={label} open={open} onEscape={escape} onReturnFocus={() => trigger.current?.focus()}>
            <div className="project-chat-panel__heading"><strong>{label}</strong><Button type="text" size="small" icon={<CloseOutlined/>} aria-label={`Закрыть: ${label}`} onClick={close}/></div>
            <div className="project-chat-panel__body">{children}</div>
        </PanelBody>}>
        <Tooltip title={label} placement="bottom" trigger={['hover', 'focus']} open={open ? false : undefined}>
            <Button ref={trigger} type="text" size="small" className={icon ? 'project-chat__icon-action' : 'project-chat__tool-trigger'} icon={icon} disabled={disabled}
                aria-label={label} aria-haspopup="dialog" aria-expanded={open} onKeyDown={escape}>{caption ?? (icon ? undefined : label)}</Button>
        </Tooltip>
    </Popover>;
}

function PanelBody({label, open, onEscape, onReturnFocus, children}: {label: string; open: boolean; onEscape: (event: React.KeyboardEvent<HTMLElement>) => void; onReturnFocus: () => void; children: ReactNode}): JSX.Element {
    const panel = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let current = true;
        if (open) queueMicrotask(() => {if (current && panel.current?.isConnected) panel.current.focus();});
        else if (panel.current?.contains(document.activeElement)) onReturnFocus();
        return () => {current = false;};
    }, [open]);
    return <div ref={panel} className="project-chat-panel__panel" role="dialog" aria-label={label} tabIndex={-1} onKeyDown={onEscape}>{children}</div>;
}
