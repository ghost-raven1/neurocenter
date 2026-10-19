import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import bffApi from '../../core/api/bff';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { authDataScope } from '../../features/UserBlock/authDataScope';
import type { RootState } from '../../store';

import { createOperationsQueueController, initialOperationsQueueSnapshot } from './operationsQueueController';

/** Каждый экземпляр очереди принадлежит одному набору прав и выбранному проекту. */
export function useOperationsQueue(projectId?: string) {
    const { user, policies } = useSelector((state: RootState) => state.userBlock);
    const authScope = user?.email ? authDataScope({ user, policies }) : '';
    const scope = JSON.stringify([authScope, projectId]);
    const [snapshot, setSnapshot] = useState({ scope: '', value: initialOperationsQueueSnapshot() });
    const controller = useMemo(() => createOperationsQueueController({
        projectId,
        readList: bffApi.listOperations,
        readDetail: bffApi.getOperation,
        onChange: value => setSnapshot({ scope, value }),
    }), [scope, projectId]);

    useLayoutEffect(() => {
        if (!authScope) { return; }
        controller.activate();
        return () => controller.dispose();
    }, [controller, authScope]);

    const refreshVisible = useCallback((): void => {
        if (document.visibilityState !== 'visible') { return; }
        void controller.reload();
        void controller.refreshDetail();
    }, [controller]);

    useSectionUpdates(['operations', 'access'], refreshVisible, !!authScope);
    useEffect(() => {
        if (!authScope) { return; }
        refreshVisible();
        const timer = setInterval(refreshVisible, 15000);
        document.addEventListener('visibilitychange', refreshVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', refreshVisible);
        };
    }, [authScope, refreshVisible]);

    const value = snapshot.scope === scope && authScope ? snapshot.value : initialOperationsQueueSnapshot();
    return {
        ...value,
        setPage: controller.setPage,
        setState: controller.setState,
        reload: controller.reload,
        select: controller.select,
        close: controller.close,
        refreshDetail: controller.refreshDetail,
    };
}
