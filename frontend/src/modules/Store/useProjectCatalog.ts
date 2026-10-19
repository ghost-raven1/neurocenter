import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import bffApi from '../../core/api/bff';
import { createProjectCatalogController, initialProjectCatalogState } from './projectCatalogController';

/** Смена проекта сразу скрывает прежний каталог; старые callbacks теряют право его обновлять. */
export function useProjectCatalog(projectId: string | undefined, accessScope: string) {
    const scope = JSON.stringify([accessScope, projectId]);
    const current = useRef(scope);
    current.current = scope;
    const [snapshot, setSnapshot] = useState({ scope: '', state: initialProjectCatalogState() });
    const controller = useMemo(() => createProjectCatalogController({
        getScope: () => current.current,
        read: () => bffApi.listProjectAssets(projectId!),
        onChange: state => setSnapshot({ scope, state }),
    }), [scope, projectId]);
    useLayoutEffect(() => {
        if (!projectId) { return; }
        controller.activate();
        return () => controller.dispose();
    }, [controller, projectId]);
    useEffect(() => { if (projectId) { void controller.refresh(); } }, [controller, projectId]);
    const state = snapshot.scope === scope ? snapshot.state : initialProjectCatalogState();
    return { ...state, loading: !!projectId && state.loading, refresh: controller.refresh };
}
