import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { modelCatalogApi } from './api';
import { requireModelCatalog } from './modelCatalogState';
import type { IModelCatalog } from './types';

/** Старый ответ не меняет каталог после смены проекта, роли или сессии. */
export function useModelCatalog(projectId?: string) {
    const { captureOwner } = useAuthRequestOwner();
    const [catalog, setCatalog] = useState<IModelCatalog | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const generation = useRef(0);
    const refresh = useCallback(async (): Promise<void> => {
        const owns = captureOwner();
        if (!owns()) return;
        const request = ++generation.current;
        const current = (): boolean => owns() && request === generation.current;
        setLoading(true);
        try {
            const value = requireModelCatalog(await modelCatalogApi.list(projectId));
            if (current()) { setCatalog(value); setError(''); }
        } catch (cause) {
            if (current()) setError(errorMessage(cause, 'Не удалось загрузить каталог моделей.'));
        } finally {
            if (current()) setLoading(false);
        }
    }, [captureOwner, projectId]);
    useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
    useSectionUpdates(['catalog', 'projects', 'access'], () => { void refresh(); });
    return { catalog, loading, error, refresh };
}
