import {useEffect, useRef} from 'react';
import {tabNotifications} from './tracker';
import {tabSourceKey, type TabSnapshot} from './types';

/** Opening a view acknowledges only its tab indicator, without any server read receipt. */
export function useTabWatch(scope: string, values: readonly TabSnapshot[]) {
    const latest = useRef(values); latest.current = values;
    const keys = JSON.stringify(values.map(value => tabSourceKey(value.source)));
    useEffect(() => {
        let release = (): void => undefined;
        const sync = (): void => {release(); release = tabNotifications.view(scope, latest.current.map(value => value.source)); latest.current.forEach(value => tabNotifications.accept(scope, value));};
        const unsubscribe = tabNotifications.subscribeConfiguration(sync); sync();
        return () => {unsubscribe(); release();};
    }, [scope, keys]);
    useEffect(() => {values.forEach(value => tabNotifications.accept(scope, value));}, [scope, values]);
}
