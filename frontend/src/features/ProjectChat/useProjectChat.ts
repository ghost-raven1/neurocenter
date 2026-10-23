import {useCallback, useEffect, useRef, useState} from 'react';
import {isAxiosError} from 'axios';
import {errorMessage} from '../../common/utils/errorMessage';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {projectChatApi} from './api';
import {mergeProjectMessages, projectChatAmbiguous, projectChatRequestKey} from './model';
import {DEFAULT_PROJECT_CHAT_ROOM} from './types';
import type {ProjectChatDetail, ProjectChatIntent, ProjectChatReceipt} from './types';

/** A room revision orders snapshots; posting waits only for its receipt, never for inference. */
export function useProjectChat(projectId: string, roomId = DEFAULT_PROJECT_CHAT_ROOM) {
    const {scope, captureOwner} = useAuthRequestOwner();
    const [detail, setDetail] = useState<ProjectChatDetail>(), [loading, setLoading] = useState(true), [error, setError] = useState('');
    const [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState(''), [action, setAction] = useState<string>();
    const [retryPending, setRetryPending] = useState<string[]>([]), [accessDenied, setAccessDenied] = useState(false);
    const latest = useRef<ProjectChatDetail>(), sequence = useRef(0), active = useRef(true), reading = useRef<AbortController>(), historyRequest = useRef<AbortController>();
    const mutations = useRef(new Set<AbortController>()), actionLock = useRef(false), retryKeys = useRef(new Map<string, string>());
    const ownerKey = JSON.stringify([scope, projectId, roomId]), currentOwner = useRef(ownerKey); currentOwner.current = ownerKey;
    const capture = useCallback(() => {const owns = captureOwner(), key = ownerKey; return () => owns() && currentOwner.current === key;}, [captureOwner, ownerKey]);
    const ownerScope = useRef(ownerKey);
    const serverTailIds = useRef(new Set<string>());
    const denied = (cause: unknown): boolean => isAxiosError(cause) && [401, 403, 404].includes(cause.response?.status ?? 0);
    const clearDenied = (): void => {
        // A fresh denial supersedes every earlier authorized read, even before the parent unmounts this room.
        sequence.current++; reading.current?.abort(); historyRequest.current?.abort(); historyRequest.current = undefined; mutations.current.forEach(controller => controller.abort());
        latest.current = undefined; serverTailIds.current.clear(); retryKeys.current.clear();
        setDetail(undefined); setRetryPending([]); setLoading(false); setHistoryLoading(false); setAccessDenied(true);
    };
    const accept = (value: ProjectChatDetail): void => {
        if ((value.room.id ?? DEFAULT_PROJECT_CHAT_ROOM) !== roomId || value.room.projectId !== projectId || latest.current && value.room.revision < latest.current.room.revision) return;
        // Watched older rows and local ACKs must not conceal an unobserved gap between server pages.
        const cursor = value.history.hasMore ? value.messages.find(message => message.id === value.history.nextCursor) : undefined;
        const tail = value.messages.filter(message => !value.history.hasMore || !!cursor && BigInt(message.position) >= BigInt(cursor.position)).map(message => message.id);
        const gap = value.history.hasMore && !tail.some(id => serverTailIds.current.has(id));
        const next = {...value, messages: mergeProjectMessages(latest.current?.messages ?? [], value.messages),
            history: latest.current && !gap ? latest.current.history : value.history};
        serverTailIds.current = new Set(tail);
        latest.current = next; setDetail(next); setAccessDenied(false);
    };
    const acceptReceipt = (receipt: ProjectChatReceipt): void => {
        if ([receipt.message, ...(receipt.messages ?? [])].some(message => (message.roomId ?? DEFAULT_PROJECT_CHAT_ROOM) !== roomId)) throw new Error('Подтверждение относится к другому диалогу. Проверьте отправку.');
        if (!latest.current) return;
        const stale = receipt.roomRevision < latest.current.room.revision;
        const next = {...latest.current, room: {...latest.current.room, revision: Math.max(receipt.roomRevision, latest.current.room.revision)}, messages: mergeProjectMessages(latest.current.messages, [receipt.message, ...(receipt.messages ?? [])], stale)};
        latest.current = next; setDetail(next);
    };
    const refresh = useCallback(async (): Promise<void> => {
        const owns = capture(), read = ++sequence.current;
        reading.current?.abort(); const controller = new AbortController(); reading.current = controller;
        if (!owns() || !active.current) return;
        try {
            // Old pending slots may be outside the latest page after other participants keep posting.
            const watch = ownerScope.current === ownerKey && latest.current?.room.projectId === projectId && (latest.current.room.id ?? DEFAULT_PROJECT_CHAT_ROOM) === roomId
                ? latest.current.messages.filter(message => ['queued', 'running'].includes(message.status)).slice(0, 50).map(message => message.id) : [];
            const value = await projectChatApi.read(projectId, controller.signal, watch.length ? watch : undefined, roomId);
            if (owns() && active.current && !controller.signal.aborted && sequence.current === read) {accept(value); setError('');}
        } catch (cause) {
            if (owns() && active.current && !controller.signal.aborted && sequence.current === read) {
                if (denied(cause)) clearDenied();
                setError(errorMessage(cause, 'Не удалось обновить чат. Отправленные сообщения и черновик сохранены.'));
            }
        } finally {if (owns() && active.current && sequence.current === read) setLoading(false);}
    }, [projectId, roomId, ownerKey, capture]);
    useEffect(() => {
        active.current = true;
        if (ownerScope.current !== ownerKey) {ownerScope.current = ownerKey; latest.current = undefined; serverTailIds.current.clear(); retryKeys.current.clear(); historyRequest.current = undefined; actionLock.current = false; setAction(undefined); setDetail(undefined); setRetryPending([]); setAccessDenied(false); setError(''); setHistoryError(''); setLoading(true);}
        void refresh();
        const timer = setInterval(() => {if (document.visibilityState !== 'hidden') void refresh();}, 4000);
        return () => {active.current = false; sequence.current++; clearInterval(timer); reading.current?.abort(); historyRequest.current?.abort(); mutations.current.forEach(value => value.abort());};
    }, [refresh]);
    useSectionUpdates(['project_chat', 'projects', 'access'], () => {void refresh();});
    const loadEarlier = async (): Promise<void> => {
        const before = latest.current?.history.nextCursor, owns = capture();
        if (!before || historyRequest.current || !owns() || !active.current) return;
        const controller = new AbortController(); historyRequest.current = controller; setHistoryLoading(true); setHistoryError('');
        try {
            const page = await projectChatApi.history(projectId, before, controller.signal, roomId);
            if (!owns() || !active.current || controller.signal.aborted || !latest.current) return;
            if (page.messages.some(message => (message.roomId ?? DEFAULT_PROJECT_CHAT_ROOM) !== roomId)) throw new Error('История относится к другому диалогу.');
            const next = {...latest.current, messages: mergeProjectMessages(latest.current.messages, page.messages, true), history: page.history};
            latest.current = next; setDetail(next);
        } catch (cause) {if (owns() && active.current && !controller.signal.aborted) {
            if (denied(cause)) clearDenied();
            setHistoryError(errorMessage(cause, 'Не удалось загрузить ранние сообщения. Повторите.'));
        }}
        finally {if (historyRequest.current === controller) {historyRequest.current = undefined; if (owns() && active.current) setHistoryLoading(false);}}
    };
    const send = async (intent: ProjectChatIntent): Promise<ProjectChatReceipt> => {
        const controller = new AbortController(), owns = capture(); mutations.current.add(controller);
        try {
            const receipt = await projectChatApi.send(projectId, intent, controller.signal, roomId);
            if (!owns() || !active.current || controller.signal.aborted) throw new Error('Подтверждение отправки не применено: доступ или диалог изменился. Проверьте сообщения перед повтором.');
            acceptReceipt(receipt); void refresh();
            return receipt;
        } catch (cause) {if (owns() && active.current && denied(cause)) clearDenied(); throw cause;} finally {mutations.current.delete(controller);}
    };
    const perform = async (id: string, work: (signal: AbortSignal) => Promise<ProjectChatDetail | ProjectChatReceipt>): Promise<boolean> => {
        const owns = capture(); if (!owns() || actionLock.current || !active.current) return false;
        actionLock.current = true; setAction(id); setError(''); const controller = new AbortController(); mutations.current.add(controller);
        try {const value = await work(controller.signal); if (!owns() || !active.current || controller.signal.aborted) return false; if ('room' in value) accept(value); else acceptReceipt(value); void refresh(); return true;}
        catch (cause) {if (owns() && active.current && !controller.signal.aborted) {
            if (denied(cause)) clearDenied();
            setError(errorMessage(cause, 'Действие не подтверждено. Обновите чат и повторите.'));
        } return false;}
        finally {mutations.current.delete(controller); if (owns() && active.current) {actionLock.current = false; setAction(undefined);}}
    };
    const retry = (id: string): Promise<boolean> => {
        if (actionLock.current) return Promise.resolve(false);
        let key = retryKeys.current.get(id); if (!key) {key = projectChatRequestKey(); retryKeys.current.set(id, key);}
        let ambiguous = false; const owns = capture();
        return perform(id, async signal => {
            try {return await projectChatApi.retry(projectId, id, key!, signal, roomId);}
            catch (cause) {ambiguous = projectChatAmbiguous(cause); throw cause;}
        }).then(ok => {
            if (!owns() || !active.current) return ok;
            if (ok || !ambiguous) retryKeys.current.delete(id);
            setRetryPending(previous => ambiguous && !ok ? [...new Set([...previous, id])] : previous.filter(value => value !== id));
            return ok;
        });
    };
    const cancel = (id: string): Promise<boolean> => perform(id, signal => projectChatApi.cancel(projectId, id, signal, roomId));
    const configure = (agentIds: string[], modelId?: string, modelPin?: string, expectedRevision?: number): Promise<boolean> => {
        const value = latest.current; if (!value) return Promise.resolve(false);
        return perform('participants', signal => projectChatApi.participants(projectId, expectedRevision ?? value.room.revision, agentIds, modelId, modelPin, signal, roomId));
    };
    return {detail: detail?.room.projectId === projectId && (detail.room.id ?? DEFAULT_PROJECT_CHAT_ROOM) === roomId ? detail : undefined, loading, error, accessDenied, refresh, historyLoading, historyError, loadEarlier, send, action, retryPending, retry, cancel, configure};
}
