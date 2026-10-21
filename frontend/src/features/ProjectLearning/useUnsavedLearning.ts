import {useEffect} from 'react';
import {useHistory} from 'react-router-dom';

/** Project evidence drafts survive accidental navigation until the user chooses to discard them. */
export function useUnsavedLearning(dirty: boolean): void {
    const history = useHistory();
    useEffect(() => {
        if (!dirty) return;
        const unblock = history.block('Текст обучения ещё не сохранён. Покинуть форму?');
        const beforeUnload = (event: BeforeUnloadEvent): void => {event.preventDefault(); event.returnValue = '';};
        window.addEventListener('beforeunload', beforeUnload);
        return () => {unblock(); window.removeEventListener('beforeunload', beforeUnload);};
    }, [dirty, history]);
}
