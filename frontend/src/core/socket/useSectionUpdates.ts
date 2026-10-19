import { useEffect, useRef } from 'react';
import socketClient from './socketClient';
import type { TLiveSection } from './interfaces';

/** Событие инвалидирует раздел; данные и права повторно читаются через обычный API. */
export function useSectionUpdates(
    sections: readonly TLiveSection[],
    refresh: () => void,
    enabled = true,
): void {
    const latest = useRef(refresh);
    latest.current = refresh;
    const key = sections.join(',');
    useEffect(() => {
        if (!enabled) {
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const reload = (): void => {
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => latest.current(), 180);
        };
        const changed = (payload: { sections: TLiveSection[] }): void => {
            if (
                payload.sections.some((section) =>
                    key.split(',').includes(section),
                )
            ) {
                reload();
            }
        };
        socketClient.connect();
        socketClient.on('section:changed', changed);
        socketClient.on('connect', reload);
        return () => {
            if (timer) {
                clearTimeout(timer);
            }
            socketClient.off('section:changed', changed);
            socketClient.off('connect', reload);
        };
    }, [key, enabled]);
}
