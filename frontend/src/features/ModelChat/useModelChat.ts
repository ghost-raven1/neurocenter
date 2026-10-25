import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import type { ICatalogModel } from '../ModelCatalog/types';
import { modelChatApi } from './api';
import { chatFileBase64, chatFileError, CHAT_FILE_MAX_COUNT } from './files';
import { mergeModelChatDetail, modelChatPromptError, modelChatTurnUnresolved, prependModelChatHistory, sortedModelChats } from './model';
import { chatRecipients } from './participants';
import type { IChatUpload, IModelChatDetail, IModelChatTurn, IModelChatConversation, IChatResearchRequest } from './types';
import {useTabWatch} from '../TabNotifications/useTabWatch';
import {modelTabSnapshot, modelTabSource} from '../TabNotifications/snapshots';
import {tabNotifications} from '../TabNotifications/tracker';

type Activity = '' | 'loading' | 'sending' | 'uploading' | 'saving';
interface ActiveRequest { abort: AbortController; kind: Activity; }
const unusedIds = (detail: IModelChatDetail | null): string[] => {
    const used = new Set(detail?.turns.flatMap(turn => turn.attachmentIds) ?? []);
    return detail?.attachments.filter(file => !used.has(file.id)).map(file => file.id) ?? [];
};

/** Persisted dialogue state is fenced by owner, selected conversation and synchronous request locks. */
export function useModelChat(model: ICatalogModel, projectId?: string, unavailableReason = '', selection?: {initialDetail?: IModelChatDetail; autoSelect: boolean}) {
    const { scope, captureOwner } = useAuthRequestOwner();
    const [items, setItems] = useState<IModelChatConversation[]>(selection?.initialDetail ? [selection.initialDetail.conversation] : []), [detail, setDetail] = useState<IModelChatDetail | null>(selection?.initialDetail ?? null);
    const [activity, setActivity] = useState<Activity>('loading'), [error, setError] = useState('');
    const [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState('');
    const [optimistic, setOptimistic] = useState<IModelChatTurn | null>(null), [uploads, setUploads] = useState<IChatUpload[]>([]);
    useTabWatch(scope, detail && detail.conversation.projectId === (projectId ?? null) ? [modelTabSnapshot(detail)] : []);
    const current = useRef(detail), list = useRef(items), pending = useRef(optimistic), fileRows = useRef(uploads);
    const mounted = useRef(false), active = useRef<ActiveRequest>(), liveModelPin = useRef(model.modelPin); liveModelPin.current = model.modelPin;
    const historyRequest = useRef<AbortController>();
    const updatePending = (value: IModelChatTurn | null): void => { pending.current = value; setOptimistic(value); };
    const updateUploads = (value: IChatUpload[]): void => { fileRows.current = value; setUploads(value); };
    const accept = (value: IModelChatDetail): void => {
        const merged = mergeModelChatDetail(current.current, value);
        current.current = merged; setDetail(merged); list.current = sortedModelChats(list.current, merged.conversation); setItems(list.current);
    };
    const abortHistory = (): void => {historyRequest.current?.abort(); historyRequest.current = undefined; setHistoryLoading(false); setHistoryError('');};
    const abortActive = (): void => { const request = active.current; active.current = undefined; request?.abort.abort(); if (mounted.current) setActivity(''); };
    const run = async (kind: Activity, action: (signal: AbortSignal, owns: () => boolean) => Promise<void>): Promise<boolean> => {
        const owner = captureOwner(); if (!mounted.current || active.current || !owner()) return false;
        const request = {abort: new AbortController(), kind}; active.current = request; setActivity(kind); setError('');
        const owns = (): boolean => mounted.current && owner() && active.current === request && !request.abort.signal.aborted;
        try { await action(request.abort.signal, owns); return owns(); }
        catch (cause) { if (owns()) setError(errorMessage(cause, 'Не удалось обновить диалог. Повторите действие.')); return false; }
        finally { if (active.current === request) { active.current = undefined; if (mounted.current && owner()) setActivity(''); } }
    };
    const ensure = async (signal: AbortSignal, owns: () => boolean): Promise<IModelChatDetail> => {
        if (current.current) return current.current;
        const value = await modelChatApi.create(model, projectId, signal); if (owns()) accept(value); return value;
    };
    useEffect(() => {
        mounted.current = true;
        const controller = new AbortController(), owner = captureOwner();
        const request = {abort: controller, kind: 'loading' as const}; active.current = request;
        const owns = (): boolean => mounted.current && owner() && active.current === request && !controller.signal.aborted;
        setActivity('loading');
        void modelChatApi.list(model.id, projectId, controller.signal).then(async values => {
            if (!owns()) return; list.current = sortedModelChats(values); setItems(list.current);
            if (selection?.autoSelect !== false && values.length) { const value = await modelChatApi.read(list.current[0].id, controller.signal); if (owns()) accept(value); }
        }).catch(cause => { if (owns()) setError(errorMessage(cause, 'Не удалось загрузить личные диалоги.')); })
            .finally(() => { if (active.current === request) { active.current = undefined; if (mounted.current && owner()) setActivity(''); } });
        return () => { mounted.current = false; active.current?.abort.abort(); active.current = undefined; historyRequest.current?.abort(); historyRequest.current = undefined; };
    }, [scope, model.id, projectId]);
    /** A failed navigation recovers the original submit without inventing cancellation or a new request key. */
    const reconcileDetachedSubmission = async (previous: IModelChatTurn | null, selected: IModelChatDetail | null, signal: AbortSignal, owns: () => boolean): Promise<void> => {
        if (previous?.status !== 'pending' || !owns()) return;
        const unknown = {...previous, status: 'failed' as const, error: 'Результат запроса не подтверждён. Можно безопасно повторить запрос.'};
        try {
            const saved = selected && await modelChatApi.read(selected.conversation.id, signal);
            if (owns()) {if (saved) accept(saved); updatePending(saved?.turns.some(turn => turn.requestId === previous.requestId) ? null : unknown);}
        } catch {if (owns()) updatePending(unknown);}
    };
    const select = async (id: string): Promise<boolean> => {
        if (!mounted.current || !captureOwner()()) return false;
        const previous = pending.current, selected = current.current;
        if (active.current?.kind === 'uploading') cancelUploads(); else abortActive(); abortHistory();
        return run('loading', async (signal, owns) => {
            try {const value = await modelChatApi.read(id, signal); if (owns()) {accept(value); updatePending(null); updateUploads([]);}}
            catch (cause) {await reconcileDetachedSubmission(previous, selected, signal, owns); throw cause;}
        });
    };
    const refresh = async (): Promise<void> => {
        await run('loading', async (signal, owns) => {
            const values = await modelChatApi.list(model.id, projectId, signal); if (!owns()) return;
            list.current = sortedModelChats(values); setItems(list.current);
            if (current.current) { const value = await modelChatApi.read(current.current.conversation.id, signal); if (owns()) { accept(value); if (pending.current && value.turns.some(turn => turn.requestId === pending.current!.requestId)) updatePending(null); } }
        });
    };
    const serverPending = detail?.turns.some(turn => turn.status === 'pending') ?? false;
    useEffect(() => {
        if (!detail || activity !== 'sending' && (activity !== '' || !serverPending)) return;
        const id = detail.conversation.id, owner = captureOwner(), controller = new AbortController();
        const sending = activity === 'sending' ? active.current : undefined;
        let timer: ReturnType<typeof setTimeout>;
        const owns = (): boolean => mounted.current && owner() && !controller.signal.aborted && current.current?.conversation.id === id
            && (!sending || active.current === sending);
        const poll = async (): Promise<void> => {
            let again = true;
            try {
                const value = await modelChatApi.read(id, controller.signal); if (!owns()) return;
                accept(value);
                if (pending.current) {
                    const saved = value.turns.find(turn => turn.requestId === pending.current!.requestId);
                    if (saved) updatePending(saved.status === 'pending' ? {...pending.current, id: saved.id, discussion: saved.discussion, executionState: saved.executionState, processingStage: saved.processingStage, responses: saved.responses, targetAgentIds: saved.targetAgentIds, research: saved.research, researchSteps: saved.researchSteps} : null);
                }
                again = !!sending || value.turns.some(turn => turn.status === 'pending');
            } catch (cause) {
                if (owns()) {
                    const unknown = (turn: IModelChatTurn): IModelChatTurn => turn.status !== 'pending' ? turn : {...turn, executionState: undefined, processingStage: undefined,
                        responses: turn.responses?.map(response => response.status !== 'pending' ? response : {...response, executionState: undefined, processingStage: undefined})};
                    if (current.current) accept({...current.current, turns: current.current.turns.map(unknown)});
                    if (pending.current) updatePending(unknown(pending.current));
                    const status = typeof cause === 'object' && cause !== null && 'response' in cause ? (cause as {response?: {status?: number}}).response?.status : undefined;
                    if (status === 401 || status === 403 || status === 404) {setError(errorMessage(cause, 'Диалог больше недоступен.')); again = false;}
                }
            } finally {if (again && owns()) timer = setTimeout(() => {void poll();}, 2000);}
        };
        timer = setTimeout(() => {void poll();}, 1000);
        return () => {clearTimeout(timer); controller.abort();};
    }, [activity, detail?.conversation.id, optimistic?.requestId, serverPending]);
    const loadEarlier = async (): Promise<void> => {
        const selected = current.current, owner = captureOwner(), cursor = selected?.history?.nextCursor;
        if (!mounted.current || !owner() || !selected?.history?.hasMore || !cursor || historyRequest.current) return;
        const controller = new AbortController(); historyRequest.current = controller; setHistoryLoading(true); setHistoryError('');
        const owns = (): boolean => mounted.current && owner() && historyRequest.current === controller && !controller.signal.aborted
            && current.current?.conversation.id === selected.conversation.id && current.current.history.nextCursor === cursor;
        try {
            const value = await modelChatApi.history(selected.conversation.id, cursor, controller.signal);
            if (owns() && current.current) accept(prependModelChatHistory(current.current, value));
        } catch (cause) {if (owns()) setHistoryError(errorMessage(cause, 'Не удалось загрузить ранние сообщения. Попробуйте снова.'));}
        finally {if (historyRequest.current === controller) {historyRequest.current = undefined; if (mounted.current && owner()) setHistoryLoading(false);}}
    };
    const newChat = async (agentIds?: string[]): Promise<boolean> => {
        if (!mounted.current || !captureOwner()()) return false;
        const previous = pending.current, selected = current.current;
        if (active.current?.kind === 'uploading') cancelUploads(); else abortActive(); abortHistory();
        return run('saving', async (signal, owns) => {
            try {const value = await modelChatApi.create(model, projectId, signal, agentIds); if (owns()) {accept(value); updatePending(null); updateUploads([]);}}
            catch (cause) {await reconcileDetachedSubmission(previous, selected, signal, owns); throw cause;}
        });
    };
    const changed = !!detail && detail.conversation.modelPin !== model.modelPin;
    const blocked = changed ? 'Подключение модели изменилось. История сохранена; начните новый диалог.' : detail?.blockedReason || unavailableReason;
    const generate = (prompt: string, attachmentIds: string[], previous?: IModelChatTurn, research?: IChatResearchRequest): boolean => {
        if (!mounted.current || active.current || blocked || !captureOwner()()) return false;
        const original = current.current, expectedPin = model.modelPin;
        if (!previous) { const problem = modelChatPromptError(prompt, attachmentIds, original); if (problem) { setError(problem); return false; } }
        const recipients = previous?.targetAgentIds ? {ids: previous.targetAgentIds} : original?.conversation.mode === 'group' ? chatRecipients(prompt, original.participants ?? []) : {ids: []};
        if (recipients.error) {setError(recipients.error); return false;}
        const requestId = previous?.id.startsWith('client:') ? previous.requestId : crypto.randomUUID();
        const consent = previous?.research ?? research;
        const temporary: IModelChatTurn = {...(consent ? {research: consent} : {}),id: previous?.id ?? `client:${requestId}`, requestId, prompt, attachmentIds, status: 'pending', createdAt: new Date().toISOString(), ...(previous?.responses ? {responses: previous.responses} : {}), ...(original?.conversation.mode === 'group' ? {targetAgentIds: previous?.targetAgentIds ?? recipients.ids} : {})};
        updatePending(temporary);
        void run('sending', async (signal, owns) => {
            let value: IModelChatDetail | null = current.current;
            try {
                value = await ensure(signal, owns); if (!owns()) return;
                if (liveModelPin.current !== expectedPin) throw new Error('Модель изменилась. Начните новый диалог.');
                tabNotifications.expect(scope, modelTabSource(value.conversation.id, projectId), [requestId]);
                const result = previous && !previous.id.startsWith('client:')
                    ? await modelChatApi.retry(value, model, previous.id, requestId, signal)
                    : await modelChatApi.send(value, model, requestId, prompt, attachmentIds, signal, original?.conversation.mode === 'group' ? temporary.targetAgentIds : undefined, consent);
                if (owns() && liveModelPin.current === expectedPin) { accept(result); updatePending(null); }
            } catch (cause) {
                if (!owns()) return;
                if (value) {
                    try {
                        const saved = await modelChatApi.read(value.conversation.id, signal);
                        if (!owns()) return; accept(saved);
                        if (saved.turns.some(turn => turn.requestId === requestId)) { updatePending(null); return; }
                    } catch { /* The unsaved request stays visible and keeps its idempotency key for a safe retry. */ }
                }
                if (owns()) updatePending({...temporary, status: 'failed', error: errorMessage(cause, 'Ответ не получен. Можно безопасно повторить запрос.')});
            }
        });
        return true;
    };
    const send = (prompt: string, research?: IChatResearchRequest): boolean => {
        if ((pending.current && modelChatTurnUnresolved(pending.current)) || fileRows.current.length) return false;
        return generate(prompt, unusedIds(current.current), undefined, research);
    };
    const retry = (): void => {
        const tail = pending.current ?? current.current?.turns[current.current.turns.length - 1];
        if (tail && tail.discussion?.mode !== 'automatic' && ['failed', 'cancelled'].includes(tail.status)) generate(tail.prompt, tail.attachmentIds, tail);
    };
    const stop = async (): Promise<void> => {
        if (!mounted.current || !captureOwner()()) return;
        const previous = pending.current, selected = current.current;
        const requestId = previous?.requestId ?? selected?.turns[selected.turns.length - 1]?.requestId;
        const ownSending = active.current?.kind === 'sending'; abortActive();
        if (ownSending && previous) updatePending({...previous, status: 'cancelled', error: 'Запрос остановлен. Сообщение можно повторить.'});
        if (!selected) return;
        await run('saving', async (signal, owns) => {
            const saved = await modelChatApi.read(selected.conversation.id, signal); if (!owns()) return;
            const tail = saved.turns.find(turn => turn.requestId === requestId);
            let result = saved;
            if (tail?.status === 'pending') {
                try {result = await modelChatApi.cancel(saved, tail.id, signal);}
                catch (cause) {
                    if (!owns()) return;
                    result = await modelChatApi.read(saved.conversation.id, signal);
                    if (result.turns.some(turn => turn.id === tail.id && turn.status === 'pending')) throw cause;
                }
            }
            if (owns()) { accept(result); if (!previous || result.turns.some(turn => turn.requestId === previous.requestId)) updatePending(null); }
        });
    };
    useEffect(() => { if (changed && active.current?.kind === 'sending') void stop(); }, [changed]);
    const editFailed = async (): Promise<string | undefined> => {
        const tail = pending.current ?? current.current?.turns[current.current.turns.length - 1]; if (!tail || tail.discussion?.mode === 'automatic' || !['failed', 'cancelled'].includes(tail.status)) return;
        let prompt: string | undefined;
        await run('saving', async (signal, owns) => {
            if (current.current) {
                const saved = await modelChatApi.read(current.current.conversation.id, signal); if (!owns()) return;
                const match = saved.turns.find(turn => turn.requestId === tail.requestId);
                const result = match ? await modelChatApi.deleteFailed(saved, match.id, signal) : saved;
                if (owns()) accept(result);
            }
            if (owns()) { updatePending(null); prompt = tail.prompt; }
        });
        return prompt;
    };
    const rename = async (title: string): Promise<boolean> => run('saving', async (signal, owns) => {
        if (!current.current) return; const value = await modelChatApi.rename(current.current.conversation.id, current.current.conversation.revision, title, signal); if (owns()) accept(value);
    });
    const configureParticipants = async (agentIds: string[]): Promise<boolean> => run('saving', async (signal, owns) => {
        if (!current.current) return; const value = await modelChatApi.participants(current.current, agentIds, signal); if (owns()) accept(value);
    });
    const complete = async (): Promise<void> => {
        const selected = current.current, tail = selected?.turns[selected.turns.length - 1];
        if (!selected || !tail || tail.discussion?.mode === 'automatic') return;
        await run('saving', async (signal, owns) => {const value = await modelChatApi.complete(selected, tail.id, signal); if (owns()) {accept(value); updatePending(null);}});
    };
    const remove = async (): Promise<boolean> => {
        const selected = current.current; if (!selected) return false;
        return run('saving', async (signal, owns) => {
            await modelChatApi.remove(selected.conversation.id, selected.conversation.revision, signal); if (!owns()) return;
            list.current = list.current.filter(value => value.id !== selected.conversation.id); setItems(list.current);
            abortHistory(); current.current = null; setDetail(null); updatePending(null); updateUploads([]);
        });
    };
    const uploadBatch = async (rows: IChatUpload[]): Promise<void> => {
        await run('uploading', async (signal, owns) => {
            for (const row of rows) {
                if (!owns()) return;
                updateUploads(fileRows.current.map(value => value.id === row.id ? {...value, state: 'uploading', error: undefined} : value));
                try {
                    const value = await ensure(signal, owns); if (!owns()) return;
                    const content = await chatFileBase64(row.file, signal); if (!owns()) return;
                    const result = await modelChatApi.upload(value.conversation.id, row.name, content, row.id, signal);
                    if (owns()) { accept(result); updateUploads(fileRows.current.filter(value => value.id !== row.id)); }
                } catch (cause) {
                    if (!owns()) return;
                    updateUploads(fileRows.current.map(value => value.id === row.id ? {...value, state: 'failed', error: errorMessage(cause, 'Не удалось прочитать документ.')} : value));
                }
            }
        });
    };
    const addFiles = (files: File[]): void => {
        if (active.current || blocked || !captureOwner()() || !files.length) return;
        if (unusedIds(current.current).length + fileRows.current.length + files.length > CHAT_FILE_MAX_COUNT) { setError('К одному сообщению можно прикрепить не больше пяти файлов.'); return; }
        const rows: IChatUpload[] = files.map(file => { const problem = chatFileError(file); return {id: crypto.randomUUID(), name: file.name, bytes: file.size, file, state: problem ? 'failed' : 'uploading', ...(problem ? {error: problem} : {})}; });
        updateUploads([...fileRows.current, ...rows]);
        const valid = rows.filter(row => row.state === 'uploading'); if (valid.length) void uploadBatch(valid);
    };
    const cancelUploads = (): void => {
        if (active.current?.kind !== 'uploading' || !captureOwner()()) return;
        abortActive(); updateUploads(fileRows.current.map(row => row.state === 'uploading' ? {...row, state: 'failed', error: 'Загрузка отменена. Можно повторить её.'} : row));
    };
    const removeUpload = (id: string): void => { if (!active.current && captureOwner()()) updateUploads(fileRows.current.filter(row => row.id !== id)); };
    const retryUpload = (id: string): void => { const row = fileRows.current.find(value => value.id === id); if (row && !active.current && !chatFileError(row.file) && !blocked && captureOwner()()) void uploadBatch([row]); };
    const removeAttachment = async (id: string): Promise<void> => { await run('saving', async (signal, owns) => { if (!current.current) return; const value = await modelChatApi.removeAttachment(current.current, id, signal); if (owns()) accept(value); }); };
    const turns = optimistic ? [...(detail?.turns.filter(turn => turn.id !== optimistic.id && turn.requestId !== optimistic.requestId) ?? []), optimistic] : detail?.turns ?? [];
    const used = new Set(turns.flatMap(turn => turn.attachmentIds));
    return {items, detail, turns, uploads, attachments: detail?.attachments.filter(file => !used.has(file.id)) ?? [], activity, error, blocked, historyLoading, historyError, loadEarlier,
        busy: activity === 'sending' || turns.some(turn => turn.status === 'pending'), send, retry, stop, select, refresh, newChat, rename, remove, editFailed, configureParticipants, complete,
        addFiles, cancelUploads, removeUpload, retryUpload, removeAttachment, captureOwner};
}
