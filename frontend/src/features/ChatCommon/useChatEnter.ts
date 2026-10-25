import {useRef, type KeyboardEvent} from 'react';

/** One Enter/IME contract for personal, team and system tasks in their common input. */
export function useChatEnter(send: () => void) {
    const composing = useRef(false);
    return {onCompositionStart: () => {composing.current = true;}, onCompositionEnd: () => {composing.current = false;},
        onPressEnter: (event: KeyboardEvent<HTMLTextAreaElement>): void => {
            if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
            event.preventDefault(); send();
        }};
}
