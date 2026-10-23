import {useCallback, useEffect, useRef, useState} from 'react';
import {isAxiosError} from 'axios';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {discussionsApi} from './api';
import {mergeComments} from './model';
import type {DiscussionComment, DiscussionPage, DiscussionTarget} from './types';

/** Each mounted thread owns its read sequence; an old page cannot replace a mutation receipt. */
export function useDiscussion(target: DiscussionTarget) {
    const {captureOwner} = useAuthRequestOwner();
    const [page, setPage] = useState<DiscussionPage>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
    const sequence = useRef(0), revoked = useRef(false);
    const load = useCallback(async (cursor?: string, preserveItems = false): Promise<void> => {
        const owns = captureOwner(), read = ++sequence.current;
        if (!owns()) return;
        setLoading(true); setError('');
        try {
            const value = await discussionsApi.list(target, cursor);
            if (owns() && sequence.current === read) {
                revoked.current = false;
                setPage(previous => cursor || preserveItems ? {...value, nextCursor: preserveItems ? previous?.nextCursor ?? value.nextCursor : value.nextCursor, items: mergeComments(previous?.items ?? [], value.items)} : value);
            }
        } catch (cause) {
            if (owns() && sequence.current === read) {
                if (isAxiosError(cause) && [401, 403, 404].includes(cause.response?.status ?? 0)) {revoked.current = true; setPage(undefined);}
                setError(errorMessage(cause, 'Не удалось загрузить обсуждение. Повторите проверку.'));
            }
        } finally {if (owns() && sequence.current === read) setLoading(false);}
    }, [captureOwner, target.type, target.id]);
    useEffect(() => {void load(); return () => {sequence.current++;};}, [load]);
    const saved = (value: DiscussionComment): void => {
        if (revoked.current) return;
        sequence.current++; setLoading(false);
        setPage(previous => previous ? {...previous, items: mergeComments(previous.items, [value])} : previous);
    };
    const removed = (id: string): void => {
        if (revoked.current) return;
        sequence.current++; setLoading(false);
        setPage(previous => previous ? {...previous, items: previous.items.map(value => value.id === id ? {...value, deleted: true, body: '', attachments: [], version: value.version + 1} : value)} : previous);
    };
    return {page, loading, error, load, saved, removed};
}
