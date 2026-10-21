import {useCallback, useEffect, useRef, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {projectLearningApi} from './api';
import {requireLearningOverview} from './model';
import type {LearningCollection, LearningOverview} from './types';

/** Project changes and auth changes invalidate pending reads before they can replace current evidence. */
export function useProjectLearning(projectId: string) {
    const {scope, captureOwner} = useAuthRequestOwner();
    const [data, setData] = useState<LearningOverview | null>(null);
    const [loading, setLoading] = useState(true), [error, setError] = useState(''), [denied, setDenied] = useState(false);
    const [loadingMore, setLoadingMore] = useState<LearningCollection | null>(null), moreLock = useRef(false);
    const context = JSON.stringify([scope, projectId]), current = useRef(context); current.current = context;
    const dataContext = useRef(context);
    const sequence = useRef(0);
    const latest = useRef(data); latest.current = data;
    const refresh = useCallback(async (): Promise<LearningOverview | null> => {
        const owns = captureOwner(), ticket = ++sequence.current;
        const active = (): boolean => owns() && current.current === context && ticket === sequence.current;
        if (!owns()) return null;
        moreLock.current = false; setLoadingMore(null);
        setLoading(true);
        try {
            const next = requireLearningOverview(await projectLearningApi.read(projectId), projectId);
            if (!active()) return null;
            dataContext.current = context; setData(next); setError(''); setDenied(false); return next;
        } catch (cause) {
            if (active()) {
                const status = (cause as {response?: {status?: number}})?.response?.status;
                const lostAccess = status === 401 || status === 403 || status === 404;
                if (lostAccess) setData(null);
                setDenied(lostAccess);
                setError(errorMessage(cause, lostAccess ? 'Нет доступа к обучению этого проекта.' : 'Не удалось обновить обучение. Показаны предыдущие данные.'));
            }
            return null;
        } finally { if (active()) setLoading(false); }
    }, [captureOwner, projectId, context]);
    useEffect(() => { setData(null); setError(''); setDenied(false); moreLock.current = false; setLoadingMore(null); void refresh(); return () => { sequence.current++; }; }, [refresh]);
    useSectionUpdates(['projects', 'access'], () => { void refresh(); });
    const loadMore = async (collection: LearningCollection): Promise<void> => {
        const owns = captureOwner(), previous = latest.current, before = previous?.pages[collection].nextCursor, ticket = sequence.current;
        const active = (): boolean => owns() && current.current === context && ticket === sequence.current;
        if (!owns() || moreLock.current || !previous || !before) return;
        moreLock.current = true; setLoadingMore(collection);
        try {
            const page = await projectLearningApi.page(projectId, collection, before);
            if (!active()) return;
            if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0 || page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor === before)) throw new Error('Некорректная следующая страница обучения.');
            const items = [...new Map([...previous[collection], ...page.items as Array<{id: string}>].map(item => [item.id, item])).values()];
            const next = requireLearningOverview({...previous, [collection]: items, pages: {...previous.pages, [collection]: {nextCursor: page.nextCursor, total: page.total}}}, projectId);
            setData(next); setError('');
        } catch (cause) {if (active()) {
            const status = (cause as {response?: {status?: number}})?.response?.status;
            if (status === 401 || status === 403 || status === 404) {setData(null); setDenied(true);}
            setError(errorMessage(cause, 'Не удалось загрузить следующую страницу.'));
        }}
        finally {if (active()) {moreLock.current = false; setLoadingMore(null);}}
    };
    return {data: dataContext.current === context ? data : null, loading, error, denied, refresh, loadMore, loadingMore};
}
