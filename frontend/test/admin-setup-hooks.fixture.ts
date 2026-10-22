/** Explicit commits exercise callback ownership and cleanup without inventing browser API results. */
export function adminSetupHooks() {
    let cursor = 0;
    type Slot = {value?: unknown; deps?: readonly unknown[]; effect?: () => void | (() => void); cleanup?: () => void};
    const slots: Slot[] = [], pending: Array<() => void> = [];
    const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) => a?.length === b.length && b.every((value, i) => Object.is(value, a[i]));
    return {
        begin() { cursor = 0; },
        commit() { pending.splice(0).forEach(run => run()); },
        replayEffects() { slots.forEach(slot => { if (slot.effect) { slot.cleanup?.(); slot.cleanup = slot.effect() || undefined; } }); },
        dispose() { slots.splice(0).forEach(slot => slot.cleanup?.()); pending.length = 0; },
        state<T>(initial: T | (() => T)) {
            const slot = slots[cursor++] ??= {value: typeof initial === 'function' ? (initial as () => T)() : initial};
            return [slot.value as T, (next: T | ((previous: T) => T)) => { slot.value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next; }] as const;
        },
        ref<T>(initial: T) { return (slots[cursor++] ??= {value: {current: initial}}).value as {current: T}; },
        memo<T>(factory: () => T, deps: readonly unknown[]) {
            const index = cursor++, old = slots[index];
            if (!old || !same(old.deps, deps)) slots[index] = {value: factory(), deps};
            return slots[index].value as T;
        },
        callback<T>(value: T, deps: readonly unknown[]) {
            const index = cursor++, old = slots[index];
            if (!old || !same(old.deps, deps)) slots[index] = {value, deps};
            return slots[index].value as T;
        },
        effect(effect: () => void | (() => void), deps: readonly unknown[]) {
            const index = cursor++, old = slots[index];
            if (old && same(old.deps, deps)) return;
            const slot: Slot = slots[index] = {deps, effect};
            pending.push(() => { old?.cleanup?.(); slot.cleanup = effect() || undefined; });
        },
    };
}

export function deferredSetup<T>() {
    let resolve!: (value: T) => void, reject!: (failure: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}
export const flushSetup = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
