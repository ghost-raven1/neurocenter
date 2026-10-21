import { useCallback, useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { errorMessage } from '../../common/utils/errorMessage';
import { activeImport, type IAssetImport } from '../AssetSources/types';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { bridgeSourceApi, readBridgeSourceImport, type IBridgeSource, type IBridgeSourceImportIntent } from './bridgeSource';

/** Подготовка поставки явная и идемпотентная; потеря ответа не создаёт второй импорт. */
export function useBridgeSourceImport(onComplete: () => void) {
    const { scope, captureOwner } = useAuthRequestOwner(), key = 'bridge-source-import:' + encodeURIComponent(scope);
    const [intent, setIntent] = useState<IBridgeSourceImportIntent>(), [job, setJob] = useState<IAssetImport>();
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [stateScope, setStateScope] = useState(scope);
    const pending = useRef(false), latestIntent = useRef<IBridgeSourceImportIntent>(), complete = useRef(onComplete);
    const lifecycle = useRef({ mounted: true, revision: 0 });
    complete.current = onComplete;
    const save = useCallback((value: IBridgeSourceImportIntent | undefined) => {
        latestIntent.current = value; setIntent(value);
        try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); }
        catch { /* Работа продолжается в текущем окне, если браузер запретил storage. */ }
    }, [key]);
    useEffect(() => {
        lifecycle.current = { mounted: true, revision: lifecycle.current.revision + 1 };
        pending.current = false; setStateScope(scope); setJob(undefined); setBusy(false); setError('');
        let saved: IBridgeSourceImportIntent | undefined;
        try { saved = readBridgeSourceImport(localStorage.getItem(key)); } catch { /* Storage недоступен. */ }
        latestIntent.current = saved; setIntent(saved);
        const owns = captureOwner(); let closed = false;
        if (saved) void bridgeSourceApi.job(saved).then(data => {
            if (owns() && !closed) { save({ ...saved, jobId: data.id }); setJob(data); if (!activeImport(data.state)) complete.current(); }
        }).catch(cause => { if (owns() && !closed) setError(errorMessage(cause, 'Не удалось восстановить подготовку моста. Повторите сохранённый запрос.')); });
        return () => { closed = true; lifecycle.current = { mounted: false, revision: lifecycle.current.revision + 1 }; };
    }, [key, captureOwner, save]);
    useEffect(() => {
        if (!job || !activeImport(job.state) || !intent) return;
        const owns = captureOwner(); let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            try {
                const data = await bridgeSourceApi.job({ ...intent, jobId: job.id });
                if (!owns() || closed) return;
                setJob(data); setError('');
                if (!activeImport(data.state)) { complete.current(); return; }
            } catch (cause) { if (owns() && !closed) setError(errorMessage(cause, 'Связь прервалась. Подготовка продолжается на сервере.')); }
            if (owns() && !closed) timer = setTimeout(() => void poll(), 1500);
        };
        timer = setTimeout(() => void poll(), 1000);
        return () => { closed = true; if (timer) clearTimeout(timer); };
    }, [job?.id, job?.state, intent, captureOwner]);
    const submit = async (saved: IBridgeSourceImportIntent) => {
        const owns = captureOwner();
        if (!owns() || !lifecycle.current.mounted || pending.current) return;
        const revision = lifecycle.current.revision;
        const current = () => owns() && lifecycle.current.mounted && lifecycle.current.revision === revision;
        pending.current = true; setBusy(true); setError(''); setJob(undefined); save(saved);
        try {
            const data = await bridgeSourceApi.import(saved);
            if (current()) { save({ ...saved, jobId: data.id }); setJob(data); if (!activeImport(data.state)) complete.current(); }
        } catch (cause) {
            if (current()) {
                setError(errorMessage(cause, 'Сервер не подтвердил приём запроса. Повтор сохранит тот же ключ.'));
                // Явный отказ до постановки не оставляет неопределённую операцию в форме.
                if (isAxiosError(cause) && [400, 403, 409].includes(cause.response?.status ?? 0)) save(undefined);
            }
        } finally { if (current()) { pending.current = false; setBusy(false); } }
    };
    const action = async (value: 'retry' | 'cancel' | 'resolve'): Promise<boolean> => {
        const owns = captureOwner(); if (!owns() || !lifecycle.current.mounted || pending.current || !job) return false;
        const revision = lifecycle.current.revision;
        const current = () => owns() && lifecycle.current.mounted && lifecycle.current.revision === revision;
        pending.current = true; setBusy(true); setError('');
        try {
            const data = value === 'resolve' ? await bridgeSourceApi.resolve(job.id, job.planDigest) : await bridgeSourceApi.action(job.id, value);
            if (current()) { setJob(data); if (!activeImport(data.state)) complete.current(); return true; }
        } catch (cause) { if (current()) setError(errorMessage(cause, 'Не удалось изменить подготовку поставки.')); }
        finally { if (current()) { pending.current = false; setBusy(false); } }
        return false;
    };
    const visible = stateScope === scope;
    return { intent: visible ? intent : undefined, job: visible ? job : undefined, busy: visible && busy, error: visible ? error : '',
        blocked: visible && (busy || !!job && activeImport(job.state) || !!intent && !job),
        start: (source: IBridgeSource) => latestIntent.current && !job ? submit(latestIntent.current) : source.available ? submit({ expectedRevision: source.revision, commit: source.available.repositoryCommit,
            assetId: source.available.assetId, requestKey: crypto.randomUUID() }) : Promise.resolve(),
        repeat: () => latestIntent.current ? submit(latestIntent.current) : Promise.resolve(),
        retry: () => action('retry'), cancel: () => action('cancel'), resolve: () => action('resolve'),
        clear: () => { if (lifecycle.current.mounted && !pending.current && (!job || !activeImport(job.state))) { save(undefined); setJob(undefined); setError(''); } },
    };
}
