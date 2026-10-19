/** Не даёт ответу старой формы изменять интерфейс или продолжать записи после смены сессии. */
export function createAuthRequestOwner(scope: string, currentScope: () => string) {
    let active = false;
    let generation = 0;
    return {
        activate(): void { active = true; generation += 1; },
        dispose(): void { active = false; generation += 1; },
        captureOwner(): () => boolean {
            const captured = generation;
            return () => active && captured === generation && Boolean(scope) && currentScope() === scope;
        },
    };
}
