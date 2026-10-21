import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { agentCatalogApi } from './api';
import { requireAgentCatalog } from './model';
import type { IAgentCatalog } from './types';

/** Late project/session responses cannot replace current prompts or assignment state. */
export function useAgentCatalog(projectId?: string) {
    const { captureOwner } = useAuthRequestOwner();
    const [catalog, setCatalog] = useState<IAgentCatalog | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const generation = useRef(0);
    const refresh = useCallback(async (): Promise<IAgentCatalog | null> => {
        const owns = captureOwner();
        if (!owns()) return null;
        const request = ++generation.current;
        const current = (): boolean => owns() && request === generation.current;
        setLoading(true);
        try {
            const value = requireAgentCatalog(await agentCatalogApi.list(projectId));
            if (!current()) return null;
            setCatalog(value); setError(''); return value;
        } catch (cause) {
            if (current()) setError(errorMessage(cause, 'Не удалось загрузить агентов. Предыдущие данные сохранены.'));
            return null;
        } finally { if (current()) setLoading(false); }
    }, [captureOwner, projectId]);
    useEffect(() => { setCatalog(null); void refresh(); return () => { generation.current++; }; }, [refresh]);
    const pending = catalog?.deliveries.some(item => item.revision === catalog.revision && ['queued', 'running', 'reconciling'].includes(item.state)) ?? false;
    useEffect(() => {
        if (!pending) return;
        let busy = false;
        const timer = window.setInterval(() => {
            if (busy || document.visibilityState === 'hidden') return;
            busy = true; void refresh().finally(() => { busy = false; });
        }, 3000);
        return () => window.clearInterval(timer);
    }, [pending, refresh]);
    useSectionUpdates(['catalog', 'projects', 'access'], () => { void refresh(); });
    return { catalog, loading, error, refresh };
}
