import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import baseApi from '../../core/api/base';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import type { UsageFilters, UsageReport } from './types';

/** Identity and query generations prevent a stale report from crossing role, project or filter changes. */
export function useModelUsage(filters: UsageFilters) {
    const { scope, captureOwner } = useAuthRequestOwner(), [data, setData] = useState<UsageReport>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
    const request = useRef(0), abort = useRef<AbortController>();
    const load = useCallback(async (cursor?: string) => {
        const owns = captureOwner(); if (!owns()) return;
        abort.current?.abort(); const controller = new AbortController(); abort.current = controller; const generation = ++request.current;
        const current = () => owns() && generation === request.current && !controller.signal.aborted;
        setLoading(true); setError('');
        try {
            const response = await baseApi.get<UsageReport>('/api/model-usage', { params: { ...filters, ...(cursor ? { cursor } : {}) }, signal: controller.signal });
            if (current()) setData(previous => cursor && previous ? { ...response.data, items: [...previous.items, ...response.data.items.filter(item => !previous.items.some(old => old.id === item.id))] } : response.data);
        } catch (cause) { if (current()) setError(errorMessage(cause, 'Не удалось загрузить использование моделей. Повторите запрос.')); }
        finally { if (current()) setLoading(false); }
    }, [captureOwner, filters]);
    useLayoutEffect(() => { setData(undefined); setError(''); void load(); return () => { request.current++; abort.current?.abort(); }; }, [scope, load]);
    return { data, loading, error, refresh: () => load(), more: () => data?.history.nextCursor ? load(data.history.nextCursor) : Promise.resolve() };
}
