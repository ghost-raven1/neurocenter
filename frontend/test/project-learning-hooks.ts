/** Deterministic hooks harness exercises owners and deferred responses without timing sleeps. */
export function learningHooks() {
    let cursor = 0;
    const slots: Array<{value?: unknown; deps?: unknown[]; cleanup?: () => void}> = [], effects: Array<() => void> = [];
    return {
        begin: () => {cursor = 0;},
        commit: () => {effects.splice(0).forEach(effect => effect());},
        dispose: () => {slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0;},
        useState: (initial: unknown) => {const slot = slots[cursor++] ??= {value: typeof initial === 'function' ? initial() : initial}; return [slot.value, (value: unknown) => {slot.value = typeof value === 'function' ? value(slot.value) : value;}];},
        useRef: (initial: unknown) => (slots[cursor++] ??= {value: {current: initial}}).value,
        useCallback: (callback: unknown, deps: unknown[]) => {const index = cursor++, previous = slots[index]; if (previous?.deps?.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return previous.value; slots[index] = {value: callback, deps}; return callback;},
        useEffect: (effect: () => void | (() => void), deps: unknown[]) => {const index = cursor++, previous = slots[index]; if (previous?.deps?.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return; const slot = slots[index] = {deps}; effects.push(() => {previous?.cleanup?.(); slot.cleanup = effect() || undefined;});},
    };
}
export function learningDeferred<T>() {let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
export const flushLearning = async () => {for (let n = 0; n < 16; n++) await Promise.resolve();};
