import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useSelector, useStore } from 'react-redux';

import bffApi from '../../core/api/bff';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { authDataScope } from '../../features/UserBlock/authDataScope';
import type { RootState } from '../../store';

import { createAvailableProjectsController, initialAvailableProjectsState } from './availableProjectsController';

function currentScope(state: RootState): string {
    const { user, policies } = state.userBlock;
    return user?.email ? authDataScope({ user, policies }) : '';
}

/** Начальная загрузка, повтор и live-обновление проходят через одного владельца списка. */
export function useAvailableProjects() {
    const store = useStore<RootState>();
    const scope = useSelector(currentScope);
    const [snapshot, setSnapshot] = useState({ scope: '', state: initialAvailableProjectsState() });
    const controller = useMemo(() => createAvailableProjectsController({
        getScope: () => currentScope(store.getState()),
        readPage: bffApi.listProjects,
        onChange: state => setSnapshot({ scope, state }),
    }), [scope, store]);

    useLayoutEffect(() => {
        if (!scope) { return; }
        controller.activate();
        return () => controller.dispose();
    }, [controller, scope]);
    useEffect(() => { if (scope) { void controller.refresh(); } }, [controller, scope]);
    useSectionUpdates(['projects', 'access'], () => { void controller.refresh(); }, !!scope);

    const state = scope && snapshot.scope === scope ? snapshot.state : initialAvailableProjectsState();
    return { ...state, scope, refresh: controller.refresh };
}
