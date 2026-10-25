import {useCallback, useRef, useState} from 'react';
import type {ChatRoleAction} from './types';

/** A late child cleanup/action cannot replace the composer controls of another origin or task. */
export function useChatRoleAction(owner: string | undefined) {
    const live = useRef(owner); live.current = owner;
    const [slot, setSlot] = useState<{owner: string; action: ChatRoleAction}>();
    const register = useCallback((action?: ChatRoleAction): void => {
        if (!owner || live.current !== owner) return;
        setSlot(action ? {owner,action} : undefined);
    }, [owner]);
    return {action: owner && slot?.owner === owner ? slot.action : undefined,register};
}
