import {forwardRef, type HTMLAttributes} from 'react';

/** A single accessible message log; each transport retains its history and scroll owner. */
export const ChatLog = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ChatLog(props, ref) {
    return <div {...props} ref={ref} role="log" aria-live="polite" aria-relevant="additions text"/>;
});
