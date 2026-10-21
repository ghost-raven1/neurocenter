import {useEffect, useRef, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {modelChatApi} from './api';
import type {IChatResearchHistory} from './types';

/** Historical attempts page independently of messages; private full outputs still load one step at a time. */
export function useChatResearchHistory(open: boolean, conversationId: string, turnId: string, requestId: string) {
    const {captureOwner} = useAuthRequestOwner();
    const [page, setPage] = useState<IChatResearchHistory>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
    const current = useRef(page), active = useRef<AbortController>(), mounted = useRef(false);
    const load = async (more = false): Promise<void> => {
        if (active.current || !mounted.current) return;
        const before = more ? current.current?.history.nextCursor ?? undefined : undefined;
        if (more && (!before || !current.current?.history.hasMore)) return;
        const controller = new AbortController(), owner = captureOwner(); active.current = controller; setLoading(true); setError('');
        const owns = (): boolean => mounted.current && owner() && active.current === controller && !controller.signal.aborted;
        try {
            const result = await modelChatApi.researchHistory(conversationId, turnId, before, controller.signal);
            if (owns()) {
                const items = more ? [...current.current?.items ?? [], ...result.items] : result.items;
                current.current = {...result, items: [...new Map(items.map(item => [item.id, item])).values()]}; setPage(current.current);
            }
        } catch (cause) {if (owns()) setError(errorMessage(cause, 'Не удалось загрузить историю исследования.'));}
        finally {if (active.current === controller) {active.current = undefined; if (mounted.current && owner()) setLoading(false);}}
    };
    useEffect(() => {
        if (!open) return;
        mounted.current = true; current.current = undefined; setPage(undefined); void load();
        return () => {mounted.current = false; active.current?.abort(); active.current = undefined;};
    }, [open, conversationId, turnId, requestId, captureOwner]);
    return {page, loading, error, retry: () => {void load(!!current.current);}, more: () => {void load(true);}};
}
