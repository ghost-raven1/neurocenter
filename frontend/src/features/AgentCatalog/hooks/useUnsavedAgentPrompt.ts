import { useUnsavedChanges } from '../../../common/hooks/useUnsavedChanges';

/** Protect unsaved edits owned by this feature. */
export function useUnsavedAgentPrompt(dirty: boolean): void {
    useUnsavedChanges(dirty, 'Промпт изменён и ещё не сохранён. Покинуть редактор?');
}
