import { useCallback, useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { useLocation } from 'react-router-dom';
import { errorMessage } from '../../../common/utils/errorMessage';
import { packagingApi } from './api';
import type { ToolBuild, ToolBuildRequest } from './types';
import { acceptBuildProgress, buildSubmissionRequest, BuildRequestUnresolvedError, readPendingBuild, resumePendingBuild, savePendingBuild } from './pendingBuild';
import { readBuildCheckpoint, saveBuildCheckpoint } from './buildRecovery';

const finished = (job: ToolBuild): boolean => ['SUCCEEDED', 'FAILED'].includes(job.state);
const readSavedJob = (scope: string): string | undefined => readBuildCheckpoint(scope, 'job');
const saveJob = (scope: string, id?: string): boolean => saveBuildCheckpoint(scope, 'job', id);

/** Ключ запроса сохраняется при сетевой ошибке, прогресс возобновляется после закрытия окна. */
export function useToolBuild(scope: string) {
    const location = useLocation();
    const [loadedScope, setLoadedScope] = useState(scope);
    const [job, setJob] = useState<ToolBuild>();
    const [jobId, setJobId] = useState<string>();
    const [pendingKey, setPendingKey] = useState<string>();
    const [unresolvedKey, setUnresolvedKey] = useState<string>();
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const owner = useRef(0);
    const request = useRef<{ signature: string; key: string }>();
    const busy = useRef(false);
    const jobKnown = useRef(false);
    const apply = useCallback((next: ToolBuild) => {
        jobKnown.current = true;
        setError('');
        setJob(previous => acceptBuildProgress(previous, next));
        setJobId(next.id);
        if (saveJob(scope, next.id)) savePendingBuild(scope);
        setPendingKey(undefined); setUnresolvedKey(undefined);
    }, [scope]);

    useEffect(() => {
        owner.current++;
        const saved = readSavedJob(scope);
        busy.current = false; jobKnown.current = !!saved;
        setLoadedScope(scope);
        setJob(undefined); setJobId(saved); setPendingKey(saved ? undefined : readPendingBuild(scope)); setUnresolvedKey(undefined); setError(''); setSubmitting(false); request.current = undefined;
        if (saved) savePendingBuild(scope);
        return () => { owner.current++; };
    }, [scope, apply]);

    useEffect(() => {
        if (loadedScope !== scope) return;
        if (jobId) saveJob(scope, jobId);
        else if (pendingKey || unresolvedKey) saveBuildCheckpoint(scope, 'request', pendingKey || unresolvedKey);
    }, [location.pathname, location.search, location.hash, loadedScope, scope, jobId, pendingKey, unresolvedKey]);

    useEffect(() => {
        if (!pendingKey || jobId) return;
        const controller = new AbortController();
        const current = owner.current;
        void resumePendingBuild(pendingKey, packagingApi.lookup, controller.signal, () => {
            if (!controller.signal.aborted) setError('Проверяем, принял ли сервер запрос. Новую сборку не запускаем.');
        }).then(next => { if (owner.current === current && !controller.signal.aborted) { apply(next); setError(''); } }).catch(cause => {
            if (owner.current === current && !controller.signal.aborted) {
                if (cause instanceof BuildRequestUnresolvedError) setUnresolvedKey(pendingKey);
                else savePendingBuild(scope);
                setPendingKey(undefined);
                setError(errorMessage(cause, 'Не удалось найти запрос сборки. Проверьте операции перед новой попыткой.'));
            }
        });
        return () => { controller.abort(); };
    }, [pendingKey, jobId, apply, scope]);

    useEffect(() => {
        if (!jobId || job && finished(job)) return;
        let closed = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const next = await packagingApi.get(jobId);
                if (!closed) { apply(next); setError(''); }
            } catch (cause) {
                if (!closed && isAxiosError(cause) && [403, 404].includes(cause.response?.status ?? 0)) {
                    owner.current++; busy.current = false; jobKnown.current = false; setSubmitting(false);
                    closed = true; setJobId(undefined); setJob(undefined); saveJob(scope);
                    setError(cause.response?.status === 404 ? 'Сборка не найдена. Можно начать новую упаковку.' : 'Доступ к сборке изменился. Обновите данные профиля.');
                } else if (!closed) setError(errorMessage(cause, 'Не удалось обновить прогресс. Повторяем подключение…'));
            }
            finally { if (!closed) timer = setTimeout(() => { void poll(); }, 2000); }
        };
        timer = setTimeout(() => { void poll(); }, 1000);
        return () => { closed = true; clearTimeout(timer); };
    }, [jobId, job?.state, apply, scope]);

    const submit = async (body: Omit<ToolBuildRequest, 'requestKey'>): Promise<void> => {
        if (busy.current || pendingKey || jobId && (!job || !finished(job))) return;
        const signature = JSON.stringify(body);
        const retainedKey = unresolvedKey || readPendingBuild(scope);
        request.current = buildSubmissionRequest(signature, request.current, retainedKey);
        try { savePendingBuild(scope, request.current.key); }
        catch (cause) { setError(errorMessage(cause, 'Не удалось сохранить ключ сборки.')); return; }
        const current = owner.current;
        busy.current = true; jobKnown.current = false; setSubmitting(true); setUnresolvedKey(undefined); setError('');
        setPendingKey(request.current.key);
        try {
            const next = await packagingApi.create({ ...body, requestKey: request.current.key });
            if (owner.current === current) apply(next);
        } catch (cause) {
            if (owner.current === current && !jobKnown.current) {
                if (isAxiosError(cause) && [400, 401, 403, 404, 409, 413, 422].includes(cause.response?.status ?? 0)) {
                    if (retainedKey) setUnresolvedKey(retainedKey);
                    else savePendingBuild(scope);
                    setPendingKey(undefined);
                }
                setError(errorMessage(cause, 'Ответ не получен. Проверяем сохранённый запрос сборки.'));
            }
        }
        finally { if (owner.current === current) { busy.current = false; setSubmitting(false); } }
    };
    const recheck = (): void => { if (unresolvedKey) {setPendingKey(unresolvedKey); setUnresolvedKey(undefined); setError('');} };
    const reset = (): void => {
        if (pendingKey || unresolvedKey || jobId && (!job || !finished(job))) return;
        owner.current++; busy.current = false; jobKnown.current = false;
        setSubmitting(false); setJob(undefined); setJobId(undefined); setError(''); request.current = undefined; saveJob(scope);
    };
    return { job, submitting, error, submit, reset, recheck, unresolved: !!unresolvedKey, active: !!pendingKey || !!jobId && (!job || !finished(job)) };
}
