import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { modelCatalogApi } from './api';
import { modelHostingBusy } from './modelCatalogState';
import type { ICatalogModel, IModelHosting, TModelHostingAction } from './types';

/** Хостинг работает на сервере; закрытие карточки не прерывает операцию. */
export function useModelHosting(model: ICatalogModel) {
    const { captureOwner } = useAuthRequestOwner();
    const [hosting, setHosting] = useState<IModelHosting | null>(null);
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const request = useRef(0);
    const lock = useRef(false);
    const reading = useRef(false);
    const mounted = useRef(false);
    const queued = useRef(false);
    const latestRefresh = useRef<() => Promise<void>>(async () => undefined);
    const refresh = useCallback(async (): Promise<void> => {
        const owns = captureOwner();
        if (!owns() || lock.current) return;
        if (reading.current) { queued.current = true; return; }
        reading.current = true;
        const generation = ++request.current;
        const current = (): boolean => owns() && generation === request.current;
        setLoading(true);
        try {
            const value = await modelCatalogApi.hosting(model.id);
            if (current()) { setHosting(value); setError(''); }
        } catch (cause) {
            if (current()) setError(errorMessage(cause, 'Не удалось проверить состояние хостинга.'));
        } finally {
            reading.current = false;
            if (current()) setLoading(false);
            if (queued.current && mounted.current) {
                queued.current = false;
                void latestRefresh.current();
            }
        }
    }, [model.id, captureOwner]);
    latestRefresh.current = refresh;
    useEffect(() => {
        mounted.current = true; void refresh();
        return () => { mounted.current = false; queued.current = false; request.current++; };
    }, [refresh]);
    const busy = modelHostingBusy(hosting);
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(() => { void refresh(); }, 2000);
        return () => clearInterval(timer);
    }, [busy, refresh]);
    const operate = async (action: TModelHostingAction): Promise<void> => {
        const owns = captureOwner();
        if (!owns() || lock.current || busy) return;
        lock.current = true; ++request.current; setSubmitting(true); setError('');
        try {
            const value = await modelCatalogApi.operate(model, action);
            if (owns()) setHosting(value);
        } catch (cause) {
            if (owns()) setError(errorMessage(cause, 'Не удалось запустить операцию с моделью.'));
        } finally {
            lock.current = false;
            if (owns()) setSubmitting(false);
        }
    };
    return { hosting, loading, busy: busy || submitting, error, refresh, operate };
}
