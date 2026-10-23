import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {isAxiosError} from 'axios';
import baseApi from '../../core/api/base';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import type { UsageFacets, UsageFilters, UsageReport } from './types';
import {sameUsageScope, usageScopeKey} from './scope';

/** Identity and query generations prevent a stale report from crossing role, project or filter changes. */
export function useModelUsage(filters: UsageFilters) {
    const { scope, captureOwner } = useAuthRequestOwner(), [data, setData] = useState<UsageReport>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
    const facetScope = JSON.stringify([scope, filters.days]);
    const [facets, setFacets] = useState<{scope: string; value: UsageFacets}>();
    const request = useRef(0), abort = useRef<AbortController>(), latest = useRef<UsageReport>();
    const load = useCallback(async (cursor?: string) => {
        const owns = captureOwner(); if (!owns()) return;
        abort.current?.abort(); const controller = new AbortController(); abort.current = controller; const generation = ++request.current;
        const current = () => owns() && generation === request.current && !controller.signal.aborted;
        setLoading(true); setError('');
        try {
            let response = await baseApi.get<UsageReport>('/api/model-usage', { params: { ...filters, ...(cursor ? { cursor } : {}) }, signal: controller.signal });
            let append = !!cursor;
            if (current() && append && !sameUsageScope(latest.current?.scope, response.data.scope)) {
                latest.current = undefined; setData(undefined); setFacets(undefined); append = false;
                // Restart at a changed, confirmed scope. Legacy pages replace cache so their cursor can progress.
                if (usageScopeKey(response.data.scope) !== null) response = await baseApi.get<UsageReport>('/api/model-usage', {params: {...filters}, signal: controller.signal});
            }
            if (current()) {
                const previous = latest.current;
                latest.current = append && previous ? {...response.data, items: [...previous.items, ...response.data.items.filter(item => !previous.items.some(old => old.id === item.id))]} : response.data;
                setData(latest.current);
                setFacets({scope: facetScope, value: response.data.facets});
            }
        } catch (cause) { if (current()) {
            if (isAxiosError(cause) && [401, 403, 404].includes(cause.response?.status ?? 0)) {latest.current = undefined; setData(undefined); setFacets(undefined);}
            setError(errorMessage(cause, 'Не удалось загрузить использование моделей. Повторите запрос.'));
        } }
        finally { if (current()) setLoading(false); }
    }, [captureOwner, filters, facetScope]);
    useLayoutEffect(() => { latest.current = undefined; setData(undefined); setError(''); void load(); return () => { request.current++; abort.current?.abort(); }; }, [scope, load]);
    return { data, facets: facets?.scope === facetScope ? facets.value : undefined, loading, error, refresh: () => load(), more: () => data?.history.nextCursor ? load(data.history.nextCursor) : Promise.resolve() };
}
