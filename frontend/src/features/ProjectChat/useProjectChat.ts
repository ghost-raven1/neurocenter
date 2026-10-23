import {useCallback, useEffect, useRef, useState} from 'react';
import {isAxiosError} from 'axios';
import {errorMessage} from '../../common/utils/errorMessage';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {projectChatApi} from './api';
import {mergeProjectMessages, projectChatAmbiguous, projectChatRequestKey} from './model';
import type {ProjectChatDetail, ProjectChatIntent, ProjectChatReceipt} from './types';

/** A room revision orders snapshots; posting waits only for its receipt, never for inference. */
export function useProjectChat(projectId: string) {
    const {scope, captureOwner} = useAuthRequestOwner();
    const [detail, setDetail] = useState<ProjectChatDetail>(), [loading, setLoading] = useState(true), [error, setError] = useState('');
    const [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState(''), [action, setAction] = useState<string>();
    const [retryPending, setRetryPending] = useState<string[]>([]);
    const latest = useRef<ProjectChatDetail>(), sequence = useRef(0), active = useRef(true), reading = useRef<AbortController>(), historyRequest = useRef<AbortController>();
    const mutations = useRef(new Set<AbortController>()), actionLock = useRef(false), retryKeys = useRef(new Map<string, string>());
    const ownerScope = useRef(scope);
    const serverTailIds = useRef(new Set<string>());
    const accept = (value: ProjectChatDetail): void => {
        if (value.room.projectId !== projectId || latest.current && value.room.revision < latest.current.room.revision) return;
        // Watched older rows and local ACKs must not conceal an unobserved gap between server pages.
        const cursor = value.history.hasMore ? value.messages.find(message => message.id === value.history.nextCursor) : undefined;
        const tail = value.messages.filter(message => !value.history.hasMore || !!cursor && BigInt(message.position) >= BigInt(cursor.position)).map(message => message.id);
        const gap = value.history.hasMore && !tail.some(id => serverTailIds.current.has(id));
        const next = {...value, messages: mergeProjectMessages(latest.current?.messages ?? [], value.messages),
            history: latest.current && !gap ? latest.current.history : value.history};
        serverTailIds.current = new Set(tail);
        latest.current = next; setDetail(next);
    };
    const acceptReceipt = (receipt: ProjectChatReceipt): void => {
        if (!latest.current) return;
        const stale = receipt.roomRevision < latest.current.room.revision;
        const next = {...latest.current, room: {...latest.current.room, revision: Math.max(receipt.roomRevision, latest.current.room.revision)}, messages: mergeProjectMessages(latest.current.messages, [receipt.message, ...(receipt.messages ?? [])], stale)};
        latest.current = next; setDetail(next);
    };
    const refresh = useCallback(async (): Promise<void> => {
        const owns = captureOwner(), read = ++sequence.current;
        reading.current?.abort(); const controller = new AbortController(); reading.current = controller;
        if (!owns() || !active.current) return;
        try {
            // Old pending slots may be outside the latest page after other participants keep posting.
            const watch = ownerScope.current === scope && latest.current?.room.projectId === projectId
                ? latest.current.messages.filter(message => ['queued', 'running'].includes(message.status)).slice(0, 50).map(message => message.id) : [];
            const value = await projectChatApi.read(projectId, controller.signal, watch.length ? watch : undefined);
            if (owns() && active.current && !controller.signal.aborted && sequence.current === read) {accept(value); setError('');}
        } catch (cause) {
            if (owns() && active.current && !controller.signal.aborted && sequence.current === read) {
                if (isAxiosError(cause) && [401, 403, 404].includes(cause.response?.status ?? 0)) {latest.current = undefined; setDetail(undefined);}
                setError(errorMessage(cause, 'Не удалось обновить чат. Отправленные сообщения и черновик сохранены.'));
            }
        } finally {if (owns() && active.current && sequence.current === read) setLoading(false);}
    }, [projectId, scope, captureOwner]);
    useEffect(() => {
        active.current = true; void refresh();
        const timer = setInterval(() => {if (document.visibilityState !== 'hidden') void refresh();}, 4000);
        return () => {active.current = false; sequence.current++; clearInterval(timer); reading.current?.abort(); historyRequest.current?.abort(); mutations.current.forEach(value => value.abort());};
    }, [refresh]);
    useSectionUpdates(['project_chat', 'projects', 'access'], () => {void refresh();});
    const loadEarlier = async (): Promise<void> => {
        const before = latest.current?.history.nextCursor, owns = captureOwner();
        if (!before || historyRequest.current || !owns() || !active.current) return;
        const controller = new AbortController(); historyRequest.current = controller; setHistoryLoading(true); setHistoryError('');
        try {
            const page = await projectChatApi.history(projectId, before, controller.signal);
            if (!owns() || !active.current || controller.signal.aborted || !latest.current) return;
            const next = {...latest.current, messages: mergeProjectMessages(latest.current.messages, page.messages, true), history: page.history};
            latest.current = next; setDetail(next);
        } catch (cause) {if (owns() && active.current && !controller.signal.aborted) {
            if (isAxiosError(cause) && [401, 403, 404].includes(cause.response?.status ?? 0)) {latest.current = undefined; setDetail(undefined);}
            setHistoryError(errorMessage(cause, 'Не удалось загрузить ранние сообщения. Повторите.'));
        }}
        finally {if (historyRequest.current === controller) {historyRequest.current = undefined; if (owns() && active.current) setHistoryLoading(false);}}
    };
    const send = async (intent: ProjectChatIntent): Promise<ProjectChatReceipt> => {
        const controller = new AbortController(), owns = captureOwner(); mutations.current.add(controller);
        try {
            const receipt = await projectChatApi.send(projectId, intent, controller.signal);
            if (owns() && active.current) {acceptReceipt(receipt); void refresh();}
            return receipt;
        } finally {mutations.current.delete(controller);}
    };
    const perform = async (id: string, work: (signal: AbortSignal) => Promise<ProjectChatDetail | ProjectChatReceipt>): Promise<boolean> => {
        const owns = captureOwner(); if (!owns() || actionLock.current || !active.current) return false;
        actionLock.current = true; setAction(id); setError(''); const controller = new AbortController(); mutations.current.add(controller);
        try {const value = await work(controller.signal); if (!owns() || !active.current) return false; if ('room' in value) accept(value); else acceptReceipt(value); void refresh(); return true;}
        catch (cause) {if (owns() && active.current && !controller.signal.aborted) {
            if (isAxiosError(cause) && [401, 403, 404].includes(cause.response?.status ?? 0)) {latest.current = undefined; setDetail(undefined);}
            setError(errorMessage(cause, 'Действие не подтверждено. Обновите чат и повторите.'));
        } return false;}
        finally {actionLock.current = false; mutations.current.delete(controller); if (owns() && active.current) setAction(undefined);}
    };
    const retry = (id: string): Promise<boolean> => {
        if (actionLock.current) return Promise.resolve(false);
        let key = retryKeys.current.get(id); if (!key) {key = projectChatRequestKey(); retryKeys.current.set(id, key);}
        let ambiguous = false; const owns = captureOwner();
        return perform(id, async signal => {
            try {return await projectChatApi.retry(projectId, id, key!, signal);}
            catch (cause) {ambiguous = projectChatAmbiguous(cause); throw cause;}
        }).then(ok => {
            if (!owns() || !active.current) return ok;
            if (ok || !ambiguous) retryKeys.current.delete(id);
            setRetryPending(previous => ambiguous && !ok ? [...new Set([...previous, id])] : previous.filter(value => value !== id));
            return ok;
        });
    };
    const cancel = (id: string): Promise<boolean> => perform(id, signal => projectChatApi.cancel(projectId, id, signal));
    const configure = (agentIds: string[], modelId?: string, modelPin?: string, expectedRevision?: number): Promise<boolean> => {
        const value = latest.current; if (!value) return Promise.resolve(false);
        return perform('participants', signal => projectChatApi.participants(projectId, expectedRevision ?? value.room.revision, agentIds, modelId, modelPin, signal));
    };
    return {detail, loading, error, refresh, historyLoading, historyError, loadEarlier, send, action, retryPending, retry, cancel, configure};
}
