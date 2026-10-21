import { useEffect } from 'react';
import { useHistory } from 'react-router-dom';

/** Protect unsaved prompt edits when navigating to another tab/page or closing the browser. */
export function useUnsavedAgentPrompt(dirty: boolean): void {
    const history = useHistory();
    useEffect(() => {
        if (!dirty) return;
        const unblock = history.block('Промпт изменён и ещё не сохранён. Покинуть редактор?');
        const beforeUnload = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ''; };
        window.addEventListener('beforeunload', beforeUnload);
        return () => { unblock(); window.removeEventListener('beforeunload', beforeUnload); };
    }, [dirty, history]);
}
