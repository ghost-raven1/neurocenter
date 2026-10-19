/** Останавливает оставшиеся назначения, когда аккаунт или права инициатора изменились. */
export async function addToProjectCatalogs(
    projects: readonly string[],
    add: (project: string) => Promise<unknown>,
    isCurrent: () => boolean,
): Promise<{ ok: number; fail: number } | null> {
    let ok = 0;
    let fail = 0;
    for (const project of projects) {
        if (!isCurrent()) { return null; }
        try {
            await add(project);
            if (!isCurrent()) { return null; }
            ok += 1;
        } catch {
            if (!isCurrent()) { return null; }
            fail += 1;
        }
    }
    return isCurrent() ? { ok, fail } : null;
}

/** Одно окно не запускает две пачки и не принимает завершение прежнего окна после сброса. */
export function createProjectCatalogBatchController() {
    let pending: symbol | null = null;
    return {
        canClose: (): boolean => pending === null,
        reset(): void { pending = null; },
        async run(options: {
            projects: readonly string[];
            add: (project: string) => Promise<unknown>;
            isOwnerCurrent: () => boolean;
            onBusyChange: (busy: boolean) => void;
            onCompleted: (result: { ok: number; fail: number }, isCurrent: () => boolean) => Promise<void>;
        }): Promise<void> {
            if (pending || !options.isOwnerCurrent()) { return; }
            const request = Symbol('project-catalog-batch');
            pending = request;
            const isCurrent = (): boolean => pending === request && options.isOwnerCurrent();
            options.onBusyChange(true);
            try {
                const result = await addToProjectCatalogs(options.projects, options.add, isCurrent);
                if (result && isCurrent()) { await options.onCompleted(result, isCurrent); }
            } finally {
                if (pending === request) {
                    pending = null;
                    if (options.isOwnerCurrent()) { options.onBusyChange(false); }
                }
            }
        },
    };
}
