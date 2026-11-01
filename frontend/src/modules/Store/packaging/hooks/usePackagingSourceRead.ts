import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../../common/utils/errorMessage';
import { readPackagingFiles } from '../sourceFiles';
import { readPackagingArchive } from '../sourceArchive';
import type { IPackagingSourceReadOptions } from './usePackagingSourceRead.interfaces';
/** Replacement commits only after a complete read; failed or stale reads never erase the previous selection. */
export function usePackagingSourceRead(options: IPackagingSourceReadOptions) {
    const latest = useRef(options);
    latest.current = options;
    const active = useRef(false),
        sequence = useRef(0),
        flight = useRef<AbortController>();
    const [error, setError] = useState('');
    useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
            flight.current?.abort();
        };
    }, []);
    useEffect(() => {
        sequence.current++;
        flight.current?.abort();
        flight.current = undefined;
        latest.current.onReading(false);
        setError('');
    }, [options.context, options.source, options.enabled]);
    const read = async (input: readonly File[], fromArchive = false): Promise<void> => {
        const start = latest.current;
        if (!active.current || !start.enabled || start.blocked || flight.current || !input.length) return;
        const selected = Array.from(input),
            generation = ++sequence.current,
            owns = start.captureCurrent(),
            controller = new AbortController();
        flight.current = controller;
        const current = () =>
            active.current &&
            !controller.signal.aborted &&
            sequence.current === generation &&
            latest.current.enabled &&
            latest.current.context === start.context &&
            latest.current.source === start.source &&
            owns();
        start.onReading(true);
        start.onStart();
        setError('');
        try {
            if (fromArchive && selected.length !== 1) throw Error('Добавьте один архив за раз.');
            const next = fromArchive
                ? await readPackagingArchive(selected[0], controller.signal)
                : await readPackagingFiles(selected);
            if (current()) await start.onRead(next, fromArchive ? selected[0].name : '', current);
        } catch (cause) {
            if (current()) {
                setError(errorMessage(cause, 'Не удалось прочитать исходники.'));
            }
        } finally {
            if (flight.current === controller) flight.current = undefined;
            if (current()) start.onReading(false);
        }
    };
    return { read, error, clearError: () => setError('') };
}
