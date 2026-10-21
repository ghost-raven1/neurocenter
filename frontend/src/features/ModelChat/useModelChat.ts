import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import type { ICatalogModel } from '../ModelCatalog/types';
import { sendModelChat } from './api';
import { modelChatIdentity, modelChatMessages, modelChatPromptError } from './model';
import type { IModelChatTurn } from './types';

/** Synchronous ownership and request guards prevent duplicate sends and late answers after cancellation. */
export function useModelChat(model: ICatalogModel, projectId?: string, unavailableReason = '') {
    const { captureOwner } = useAuthRequestOwner();
    const [turns, setTurns] = useState<IModelChatTurn[]>([]), [error, setError] = useState('');
    const [identity, setIdentity] = useState(modelChatIdentity(model));
    const current = useRef(turns), sequence = useRef(0), mounted = useRef(false);
    const active = useRef<{ id: number; abort: AbortController }>();
    const changed = identity !== modelChatIdentity(model);
    const blocked = changed ? 'Подключение модели изменилось. Начните новый диалог.' : unavailableReason;
    const live = useRef({ identity: modelChatIdentity(model) }); live.current = { identity: modelChatIdentity(model) };
    const commit = (value: IModelChatTurn[]): void => { current.current = value; setTurns(value); };
    const stop = (): void => {
        const pending = active.current; if (!pending) return;
        active.current = undefined; pending.abort.abort();
        if (mounted.current && captureOwner()()) commit(current.current.map(turn => turn.id === pending.id ? { ...turn, status: 'cancelled', error: 'Запрос остановлен. Можно повторить его или изменить сообщение.' } : turn));
    };
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; const pending = active.current; active.current = undefined; pending?.abort.abort(); }; }, []);
    useEffect(() => { if (changed) stop(); }, [changed]);

    const request = (turn: IModelChatTurn): void => {
        const owns = captureOwner(), abort = new AbortController(), expectedIdentity = identity;
        active.current = { id: turn.id, abort };
        const isCurrent = (): boolean => mounted.current && owns() && active.current?.abort === abort
            && !abort.signal.aborted && live.current.identity === expectedIdentity;
        void sendModelChat(model, modelChatMessages(current.current), projectId, abort.signal).then(answer => {
            if (!isCurrent()) return;
            commit(current.current.map(value => value.id === turn.id ? { ...value, status: 'done', answer, error: undefined } : value));
        }).catch(cause => {
            if (!isCurrent()) return;
            commit(current.current.map(value => value.id === turn.id ? { ...value, status: 'failed', error: errorMessage(cause, 'Не удалось получить ответ. Проверьте подключение модели и повторите запрос.') } : value));
        }).finally(() => {
            if (active.current?.abort !== abort) return;
            if (mounted.current && owns() && live.current.identity !== expectedIdentity) stop();
            else active.current = undefined;
        });
    };
    const send = (prompt: string): boolean => {
        if (!mounted.current || active.current || blocked || !captureOwner()()) return false;
        const problem = modelChatPromptError(prompt, current.current); setError(problem); if (problem) return false;
        const turn: IModelChatTurn = { id: ++sequence.current, prompt, status: 'pending' };
        commit([...current.current, turn]); request(turn); return true;
    };
    const retry = (): void => {
        if (!mounted.current || active.current || blocked || !captureOwner()()) return;
        const tail = current.current[current.current.length - 1]; if (!tail || !['failed', 'cancelled'].includes(tail.status)) return;
        const turn: IModelChatTurn = { id: tail.id, prompt: tail.prompt, status: 'pending' };
        commit([...current.current.slice(0, -1), turn]); setError(''); request(turn);
    };
    const editFailed = (): string | undefined => {
        if (!mounted.current || active.current || !captureOwner()()) return;
        const tail = current.current[current.current.length - 1]; if (!tail || !['failed', 'cancelled'].includes(tail.status)) return;
        commit(current.current.slice(0, -1)); setError(''); return tail.prompt;
    };
    const reset = (): void => { if (!mounted.current || !captureOwner()()) return; stop(); commit([]); setIdentity(modelChatIdentity(model)); setError(''); };
    return { turns, error, blocked, busy: turns.some(turn => turn.status === 'pending'), send, retry, stop, reset, editFailed, captureOwner };
}
