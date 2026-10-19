import { useLayoutEffect, useMemo, useState } from 'react';

import base from '../../core/api/base';

import { createCapacityStatusController, initialCapacityStatusState } from './capacityStatusController';
import type { ICapacityStatus } from './capacityStatusController';

export function useCapacityStatus() {
    const [state, setState] = useState(initialCapacityStatusState);
    const controller = useMemo(() => createCapacityStatusController(
        async () => (await base.get<ICapacityStatus>('/api/maintenance/capacity')).data,
        setState,
    ), []);

    useLayoutEffect(() => {
        controller.activate();
        void controller.refresh();
        const timer = setInterval(() => void controller.refresh(), 30000);
        return () => {
            clearInterval(timer);
            controller.dispose();
        };
    }, [controller]);

    return { ...state, refresh: controller.refresh };
}
