import { useLayoutEffect, useMemo, useState } from 'react';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { featureFlagsApi } from './api';
import { createFeatureFlagsController, initialFeatureFlagsState } from './featureFlagsController';

/** Повтор setup в StrictMode получает новый epoch; старые ответы не меняют новую панель. */
export function useFeatureFlags() {
    const { captureOwner } = useAuthRequestOwner();
    const [state, setState] = useState(initialFeatureFlagsState);
    const controller = useMemo(() => createFeatureFlagsController({
        read: featureFlagsApi.list, write: featureFlagsApi.update, captureOwner, onChange: setState,
    }), [captureOwner]);
    useLayoutEffect(() => {
        controller.activate(); void controller.refresh();
        return () => controller.dispose();
    }, [controller]);
    useSectionUpdates(['maintenance'], () => { void controller.refresh(); });
    return { ...state, refresh: controller.refresh, save: controller.save, useCurrent: controller.useCurrent };
}
