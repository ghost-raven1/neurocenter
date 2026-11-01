import { useUnsavedChanges } from '../../../common/hooks/useUnsavedChanges';

/** Protect unsaved edits owned by this feature. */
export function useUnsavedLearning(dirty: boolean): void {
    useUnsavedChanges(dirty, 'Текст обучения ещё не сохранён. Покинуть форму?');
}
