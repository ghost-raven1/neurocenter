import {useEffect, useRef, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {projectLearningApi} from './api';
import type {LearningCheck, LearningHypothesis} from './types';

/** Exact ID lookups preserve old candidate provenance outside the newest list page. */
export function useLearningHypothesis(projectId: string, id: string | undefined, local: LearningHypothesis[], focusedCheckId?: string) {
    const {scope, captureOwner} = useAuthRequestOwner();
    const context = JSON.stringify([scope, projectId, id]), current = useRef(context); current.current = context;
    const localHypothesis = local.find(item => item.id === id);
    const [remote, setRemote] = useState<LearningHypothesis | null>(null), [extraChecks, setExtraChecks] = useState<LearningCheck[]>([]);
    const [loading, setLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
    const lock = useRef(false), dataContext = useRef(context), [nextCursor, setNextCursor] = useState<string | null>(null);
    useEffect(() => {
        const owns = captureOwner(), active = (): boolean => owns() && current.current === context;
        setRemote(null); setExtraChecks([]); setError(''); setNextCursor(localHypothesis?.checksNextCursor ?? null); lock.current = false;
        if (!id || !owns()) return;
        dataContext.current = context; setLoading(true);
        void (async () => {
            const hypothesis = localHypothesis ?? await projectLearningApi.hypothesis(projectId, id);
            if (!active()) return;
            if (hypothesis.id !== id || hypothesis.projectId !== projectId || !Array.isArray(hypothesis.checks)) throw new Error('Гипотеза не принадлежит выбранному проекту.');
            setRemote(hypothesis); setNextCursor(hypothesis.checksNextCursor);
            if (focusedCheckId && !hypothesis.checks.some(check => check.id === focusedCheckId)) {
                const check = await projectLearningApi.check(projectId, id, focusedCheckId);
                if (!active()) return;
                if (check.id !== focusedCheckId || check.hypothesisId !== id || check.projectId !== projectId) throw new Error('Основание версии не соответствует гипотезе.');
                setExtraChecks([check]);
            }
        })().catch(cause => {if (active()) setError(errorMessage(cause, 'Не удалось открыть исходную гипотезу.'));})
            .finally(() => {if (active()) setLoading(false);});
    }, [captureOwner, context, projectId, id, localHypothesis, focusedCheckId, retry]);
    const hypothesis = dataContext.current === context ? localHypothesis ?? remote : null;
    const checks = hypothesis ? [...new Map([...hypothesis.checks, ...extraChecks].map(check => [check.id, check])).values()] : [];
    const loadMore = async (): Promise<void> => {
        const owns = captureOwner(), active = (): boolean => owns() && current.current === context;
        if (!id || !nextCursor || !owns() || lock.current) return;
        lock.current = true; setLoading(true); setError('');
        try {
            const page = await projectLearningApi.checks(projectId, id, nextCursor);
            if (!active()) return;
            if (!Array.isArray(page.items) || page.items.some(check => check.projectId !== projectId || check.hypothesisId !== id) || !Number.isSafeInteger(page.total) || page.total < 0
                || page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor === nextCursor)) throw new Error('Некорректная страница проверок.');
            setExtraChecks(previous => [...new Map([...previous, ...page.items].map(check => [check.id, check])).values()]); setNextCursor(page.nextCursor);
        } catch (cause) {if (active()) setError(errorMessage(cause, 'Не удалось загрузить ранние проверки.'));}
        finally {if (active()) {lock.current = false; setLoading(false);}}
    };
    return {hypothesis: hypothesis ? {...hypothesis, checks} : null, loading, error, nextCursor, loadMore, retry: () => setRetry(value => value + 1)};
}
