export type TCliJournalLock = <T>(key: string, change: () => T) => Promise<T>;

/** Only the short initial journal change is serialized; no network request holds this lock. */
export function browserCliJournalLock(): TCliJournalLock | undefined {
    let locks: LockManager | undefined;
    try {
        locks = globalThis.navigator?.locks;
    } catch {
        return undefined;
    }
    if (!locks) return undefined;
    return (key, change) =>
        locks!.request(key, { mode: 'exclusive', ifAvailable: true }, (lock) => {
            if (!lock) throw Error('Другая вкладка сохраняет проверку этого компьютера. Обновите состояние отправки.');
            return change();
        });
}
