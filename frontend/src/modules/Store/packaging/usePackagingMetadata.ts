import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../common/utils/errorMessage';

/** Явная проверка обновляет pin; новая редакция отсекает прежние ответы, включая A → B → A. */
export function usePackagingMetadata<T>(key: string, read: () => Promise<T>, fallback: string) {
    const [state, setState] = useState<{ key: string; epoch: number; metadata?: T; error?: string; loading?: boolean }>({ key, epoch: 0 });
    const current = useRef({ key, epoch: 0 });
    const mounted = useRef(true);
    const pending = useRef<{ key: string; epoch: number; promise: Promise<T> }>();
    const cache = useRef<{ key: string; metadata: T }>();
    if (current.current.key !== key) current.current = { key, epoch: current.current.epoch + 1 };
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

    const resolve = async (force = false): Promise<T> => {
        if (!mounted.current || current.current.key !== key) throw new Error('Источник изменился. Повторите проверку выбранного источника.');
        if (pending.current?.key === key && pending.current.epoch === current.current.epoch) return pending.current.promise;
        if (force) {
            current.current = { key, epoch: current.current.epoch + 1 };
            cache.current = undefined;
        }
        const epoch = current.current.epoch;
        if (cache.current?.key === key) { setState({ key, epoch, metadata: cache.current.metadata }); return cache.current.metadata; }
        setState({ key, epoch, loading: true });
        const active = () => mounted.current && current.current.key === key && current.current.epoch === epoch;
        const promise = Promise.resolve().then(read).then(metadata => {
            if (active()) { cache.current = { key, metadata }; setState({ key, epoch, metadata }); }
            return metadata;
        }).catch(cause => {
            if (active()) setState({ key, epoch, error: errorMessage(cause, fallback) });
            throw cause;
        }).finally(() => { if (pending.current?.key === key && pending.current.epoch === epoch) pending.current = undefined; });
        pending.current = { key, epoch, promise };
        return promise;
    };
    const visible = state.key === key && state.epoch === current.current.epoch;
    return { metadata: visible ? state.metadata : undefined, error: visible ? state.error ?? '' : '', loading: visible && !!state.loading, resolve };
}
