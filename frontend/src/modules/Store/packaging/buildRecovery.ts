type CheckpointKind = 'request' | 'job';
interface BuildCheckpoint { scope: string; kind: CheckpointKind; id: string }
const historyKey = 'neurocenterToolBuild';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const storageKey = (scope: string, kind: CheckpointKind): string => `neurocenter.tool-build:${scope}${kind === 'request' ? ':request' : ''}`;

function historyState(): Record<string, unknown> {
    const state: unknown = window.history.state;
    return state && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, unknown> : {};
}
function checkpoint(state: Record<string, unknown>, scope: string): BuildCheckpoint | undefined {
    const entry = state[historyKey];
    if (!entry || typeof entry !== 'object') return;
    const value = entry as Partial<BuildCheckpoint>;
    if (value.scope === scope && (value.kind === 'request' || value.kind === 'job') && typeof value.id === 'string' && uuid.test(value.id)) return value as BuildCheckpoint;
}

/** История вкладки переживает reload без localStorage и не смешивает параллельные вкладки. */
export function readBuildCheckpoint(scope: string, kind: CheckpointKind): string | undefined {
    try {
        const current = checkpoint(historyState(), scope);
        if (current) return current.kind === kind ? current.id : undefined;
    } catch { /* В среде без History API остаётся обычное хранилище. */ }
    try {
        const value = localStorage.getItem(storageKey(scope, kind));
        return value && uuid.test(value) ? value : undefined;
    } catch { return undefined; }
}

/** Сохраняет только scoped UUID; false запрещает первый POST без восстанавливаемого ключа. */
export function saveBuildCheckpoint(scope: string, kind: CheckpointKind, id?: string): boolean {
    if (id && !uuid.test(id)) throw new Error('Некорректный идентификатор сборки.');
    let saved = false;
    try {
        if (id) localStorage.setItem(storageKey(scope, kind), id);
        else localStorage.removeItem(storageKey(scope, kind));
        saved = true;
    } catch { /* История вкладки остаётся доступной при запрете Storage API. */ }
    try {
        const state = historyState();
        const current = checkpoint(state, scope);
        if (id) {
            if (current?.kind !== kind || current.id !== id) window.history.replaceState({ ...state, [historyKey]: { scope, kind, id } }, '');
            saved = true;
        } else if (current?.kind === kind) {
            const next = { ...state }; delete next[historyKey];
            window.history.replaceState(next, ''); saved = true;
        }
    } catch { /* Вызывающий код отличает полный отказ сохранения от отказа одного способа. */ }
    return saved;
}
