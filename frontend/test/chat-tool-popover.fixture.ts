import {createElement, type ReactNode} from 'react';

/** Controlled portal boundary for component tests; keyboard and portal behavior use the real AntD DOM suite. */
export function chatToolPopoverDouble({label, open, children, disabled, onOpenChange}: {label: string; open: boolean; children?: ReactNode; disabled?: boolean; onOpenChange: (open: boolean) => void}) {
    return createElement('span', null, createElement('button', {'aria-expanded': open, disabled, onClick: () => onOpenChange(!open)}, label),
        open ? createElement('div', {role: 'dialog', 'aria-label': label}, children) : null);
}
