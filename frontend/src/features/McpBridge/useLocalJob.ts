import { useEffect, useRef, useState } from 'react';
import { bridgeApi, type IBridgeJob, type IBridgeJobDraft } from './api';
import type { useBridge } from './useBridge';
import { errorMessage } from '../../common/utils/errorMessage';

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
        const key = JSON.stringify(input); const requestKey = keys.current.get(key) || crypto.randomUUID(); keys.current.set(key, requestKey);
        try {
            const job = await bridgeApi.create({ ...input, requestKey } as Parameters<typeof bridgeApi.create>[0]);
            keys.current.delete(key);
            if (mounted.current) { setSubmitted(job); await bridge.reload(); }
            return job;
        } catch (cause) { if (mounted.current) { setError(errorMessage(cause, 'Не удалось передать действие мосту.')); } }
        finally { lock.current = false; if (mounted.current) { setBusy(false); } }
    };
    return { job: bridge.jobs.find(job => job.id === submitted?.id) || submitted, busy, error, setError, submit };
}
