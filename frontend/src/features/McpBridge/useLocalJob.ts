import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { bridgeApi, type IBridgeJob, type IBridgeJobDraft } from './api';
import type { useBridge } from './useBridge';
import { errorMessage } from '../../common/utils/errorMessage';
import { createBridgeRequestKey } from './bridgeRequestKey';

/** Повтор после сетевой ошибки использует прежний requestKey и не создаёт второй запуск. */
export function useLocalJob(bridge: ReturnType<typeof useBridge>) {
    const [submitted, setSubmitted] = useState<IBridgeJob>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const lock = useRef(false); const mounted = useRef(true); const keys = useRef(new Map<string, string>());
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const submit = async (input: IBridgeJobDraft): Promise<IBridgeJob | undefined> => {
        if (!mounted.current || lock.current) { return; }
        lock.current = true; setBusy(true); setError('');
        let key = '';
        let retrying = false;
        try {
            key = JSON.stringify(input);
            const previousKey = keys.current.get(key); retrying = !!previousKey;
            const requestKey = previousKey || createBridgeRequestKey(); keys.current.set(key, requestKey);
            const job = await bridgeApi.create({ ...input, requestKey } as Parameters<typeof bridgeApi.create>[0]);
            keys.current.delete(key);
            if (mounted.current) {
                setSubmitted(job);
                // Принятый POST не зависит от скорости чтения очереди и списка установок.
                void bridge.reload().catch(() => {
                    if (mounted.current) { setError('Задание принято, но не удалось обновить его состояние. Обновите данные.'); }
                });
            }
            return job;
        } catch (cause) {
            // Первый окончательный отказ не создаёт job; поздний 4xx не опровергает ранее потерянный ACK.
            if (!retrying && isAxiosError(cause) && [400, 403, 409].includes(cause.response?.status || 0)) { keys.current.delete(key); }
            if (mounted.current) { setError(errorMessage(cause, 'Не удалось передать действие мосту.')); }
        }
        finally { lock.current = false; if (mounted.current) { setBusy(false); } }
    };
    const canRetry = (input: IBridgeJobDraft): boolean => keys.current.has(JSON.stringify(input));
    return { job: bridge.jobs.find(job => job.id === submitted?.id) || submitted, busy, error, setError, submit, canRetry };
}
