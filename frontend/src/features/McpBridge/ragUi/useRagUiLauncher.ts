import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAuthRequestOwner } from '../../UserBlock/useAuthRequestOwner';
import { bridgeApi } from '../api';
import type { useBridge } from '../useBridge';
import { createRagUiLaunchController, initialRagUiLaunchState } from './ragUiLaunchController';

/** Смена пользователя, компьютера, папки или версии сразу скрывает результат прежнего запуска. */
export function useRagUiLauncher(target: string, bridge: ReturnType<typeof useBridge>) {
    const { scope: owner, captureOwner } = useAuthRequestOwner();
    const scope = JSON.stringify([owner, target]);
    const latestScope = useRef(scope); latestScope.current = scope;
    const [snapshot, setSnapshot] = useState(initialRagUiLaunchState);
    const controller = useMemo(() => createRagUiLaunchController({
        getScope: () => latestScope.current, captureOwner, create: bridgeApi.create, reload: bridge.reload, onChange: setSnapshot,
    }), [captureOwner, bridge.reload]);
    useLayoutEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller, scope]);
    return { ...(snapshot.scope === scope ? snapshot : initialRagUiLaunchState(scope)), submit: controller.submit };
}
