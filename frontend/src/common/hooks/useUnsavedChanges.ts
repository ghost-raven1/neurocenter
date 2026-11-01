import { useEffect } from 'react';
import { useHistory } from 'react-router-dom';

/** Protect unsaved edits until the owner saves or discards them. */
export function useUnsavedChanges(dirty: boolean, message: string): void {
    const history = useHistory();
    useEffect(() => {
        if (!dirty) return;
        const unblock = history.block(message);
        const beforeUnload = (event: BeforeUnloadEvent): void => {
            event.preventDefault();
            event.returnValue = '';
        };
        window.addEventListener('beforeunload', beforeUnload);
        return () => {
            unblock();
            window.removeEventListener('beforeunload', beforeUnload);
        };
    }, [dirty, history, message]);
}
