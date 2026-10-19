import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import bffApi from '../../core/api/bff';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { authDataScope } from '../../features/UserBlock/authDataScope';
import type { RootState } from '../../store';

import { createActiveOperationsController, initialActiveOperations } from './activeOperationsController';

/** Лёгкая сводка обновляет кнопку и при закрытой, и при открытой панели. */
export function useActiveOperations() {
    const { user, policies } = useSelector((state: RootState) => state.userBlock);
    const scope = user?.email ? authDataScope({ user, policies }) : '';
    const [snapshot, setSnapshot] = useState({ scope: '', value: initialActiveOperations() });
    const controller = useMemo(() => createActiveOperationsController(
        () => bffApi.listOperations({ page: 1, size: 1 }),
        value => setSnapshot({ scope, value }),
    ), [scope]);
    const value = snapshot.scope === scope && scope ? snapshot.value : initialActiveOperations();

    useLayoutEffect(() => {
        if (!scope) { return; }
        controller.activate();
        return () => controller.dispose();
    }, [controller, scope]);

    const refreshVisible = useCallback((): void => {
        if (document.visibilityState === 'visible') { void controller.refresh(); }
    }, [controller]);
    useSectionUpdates(['operations', 'access'], refreshVisible, !!scope);

    useEffect(() => {
        if (!scope) { return; }
        refreshVisible();
        document.addEventListener('visibilitychange', refreshVisible);
        return () => document.removeEventListener('visibilitychange', refreshVisible);
    }, [scope, refreshVisible]);

    const pollingMs = value.count > 0 ? 5000 : 15000;
    useEffect(() => {
        if (!scope) { return; }
        const timer = setInterval(refreshVisible, pollingMs);
        return () => clearInterval(timer);
    }, [scope, pollingMs, refreshVisible]);

    return value;
}
