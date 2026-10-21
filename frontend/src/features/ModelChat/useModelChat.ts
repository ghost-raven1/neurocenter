import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import type { ICatalogModel } from '../ModelCatalog/types';
import { modelChatApi } from './api';
import { chatFileBase64, chatFileError, CHAT_FILE_MAX_COUNT } from './files';
import { modelChatPromptError, sortedModelChats } from './model';
import type { IChatUpload, IModelChatDetail, IModelChatTurn, IModelChatConversation } from './types';

type Activity = '' | 'loading' | 'sending' | 'uploading' | 'saving';
interface ActiveRequest { abort: AbortController; kind: Activity; }
const unusedIds = (detail: IModelChatDetail | null): string[] => {
    const used = new Set(detail?.turns.flatMap(turn => turn.attachmentIds) ?? []);
    return detail?.attachments.filter(file => !used.has(file.id)).map(file => file.id) ?? [];
};

/** Persisted dialogue state is fenced by owner, selected conversation and synchronous request locks. */
export function useModelChat(model: ICatalogModel, projectId?: string, unavailableReason = '') {
    const { scope, captureOwner } = useAuthRequestOwner();
    const [items, setItems] = useState<IModelChatConversation[]>([]), [detail, setDetail] = useState<IModelChatDetail | null>(null);
    const [activity, setActivity] = useState<Activity>('loading'), [error, setError] = useState('');
    const [optimistic, setOptimistic] = useState<IModelChatTurn | null>(null), [uploads, setUploads] = useState<IChatUpload[]>([]);
    const current = useRef(detail), list = useRef(items), pending = useRef(optimistic), fileRows = useRef(uploads);
    const mounted = useRef(false), active = useRef<ActiveRequest>(), liveModelPin = useRef(model.modelPin); liveModelPin.current = model.modelPin;
    const updatePending = (value: IModelChatTurn | null): void => { pending.current = value; setOptimistic(value); };
    const updateUploads = (value: IChatUpload[]): void => { fileRows.current = value; setUploads(value); };
    const accept = (value: IModelChatDetail): void => {
        current.current = value; setDetail(value); list.current = sortedModelChats(list.current, value.conversation); setItems(list.current);
    };
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
            if (values.length) { const value = await modelChatApi.read(list.current[0].id, controller.signal); if (owns()) accept(value); }
        }).catch(cause => { if (owns()) setError(errorMessage(cause, 'Не удалось загрузить личные диалоги.')); })
            .finally(() => { if (active.current === request) { active.current = undefined; if (mounted.current && owner()) setActivity(''); } });
        return () => { mounted.current = false; active.current?.abort.abort(); active.current = undefined; };
    }, [scope, model.id, projectId]);
    const select = async (id: string): Promise<boolean> => {
        if (!mounted.current || !captureOwner()()) return false;
        abortActive(); updatePending(null); updateUploads([]);
        return run('loading', async (signal, owns) => { const value = await modelChatApi.read(id, signal); if (owns()) accept(value); });
    };
    const refresh = async (): Promise<void> => {
        await run('loading', async (signal, owns) => {
            const values = await modelChatApi.list(model.id, projectId, signal); if (!owns()) return;
            list.current = sortedModelChats(values); setItems(list.current);
            if (current.current) { const value = await modelChatApi.read(current.current.conversation.id, signal); if (owns()) { accept(value); if (pending.current && value.turns.some(turn => turn.requestId === pending.current!.requestId)) updatePending(null); } }
        });
    };
    useEffect(() => {
        if (activity || !detail?.turns.some(turn => turn.status === 'pending')) return;
        const timer = setTimeout(() => { void refresh(); }, 2000); return () => clearTimeout(timer);
    }, [activity, detail]);
    const newChat = async (): Promise<boolean> => {
        if (!mounted.current || !captureOwner()()) return false;
        abortActive(); updatePending(null); updateUploads([]);
        return run('saving', async (signal, owns) => { const value = await modelChatApi.create(model, projectId, signal); if (owns()) accept(value); });
    };
    const changed = !!detail && detail.conversation.modelPin !== model.modelPin;
    const blocked = changed ? 'Подключение модели изменилось. История сохранена; начните новый диалог.' : detail?.blockedReason || unavailableReason;
    const generate = (prompt: string, attachmentIds: string[], previous?: IModelChatTurn): boolean => {
        if (!mounted.current || active.current || blocked || !captureOwner()()) return false;
        const original = current.current, expectedPin = model.modelPin;
        if (!previous) { const problem = modelChatPromptError(prompt, attachmentIds, original); if (problem) { setError(problem); return false; } }
        const requestId = previous?.id.startsWith('client:') ? previous.requestId : crypto.randomUUID();
        const temporary: IModelChatTurn = {id: previous?.id ?? `client:${requestId}`, requestId, prompt, attachmentIds, status: 'pending', createdAt: new Date().toISOString()};
        updatePending(temporary);
        void run('sending', async (signal, owns) => {
            let value: IModelChatDetail | null = current.current;
            try {
                value = await ensure(signal, owns); if (!owns()) return;
                if (liveModelPin.current !== expectedPin) throw new Error('Модель изменилась. Начните новый диалог.');
                const result = previous && !previous.id.startsWith('client:')
                    ? await modelChatApi.retry(value, model, previous.id, requestId, signal)
                    : await modelChatApi.send(value, model, requestId, prompt, attachmentIds, signal);
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
    const send = (prompt: string): boolean => {
        if (pending.current || fileRows.current.length) return false;
        return generate(prompt, unusedIds(current.current));
    };
    const retry = (): void => {
        const tail = pending.current ?? current.current?.turns[current.current.turns.length - 1];
        if (tail && ['failed', 'cancelled'].includes(tail.status)) generate(tail.prompt, tail.attachmentIds, tail);
    };
    const stopOwn = (): boolean => {
        if (!mounted.current || !captureOwner()() || active.current?.kind !== 'sending') return false;
        abortActive();
        if (pending.current) updatePending({...pending.current, status: 'cancelled', error: 'Запрос остановлен. Сообщение можно повторить.'});
        return true;
    };
    const stop = async (): Promise<void> => {
        if (!mounted.current || !captureOwner()()) return;
        const previous = pending.current, selected = current.current;
        if (!stopOwn()) abortActive();
        if (!selected) return;
        await run('saving', async (signal, owns) => {
            const saved = await modelChatApi.read(selected.conversation.id, signal); if (!owns()) return;
            const tail = saved.turns[saved.turns.length - 1];
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
        const tail = pending.current ?? current.current?.turns[current.current.turns.length - 1]; if (!tail || !['failed', 'cancelled'].includes(tail.status)) return;
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
    const remove = async (): Promise<boolean> => {
        const selected = current.current; if (!selected) return false;
        return run('saving', async (signal, owns) => {
            await modelChatApi.remove(selected.conversation.id, selected.conversation.revision, signal); if (!owns()) return;
            list.current = list.current.filter(value => value.id !== selected.conversation.id); setItems(list.current);
            current.current = null; setDetail(null); updatePending(null); updateUploads([]);
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
    const used = new Set(detail?.turns.flatMap(turn => turn.attachmentIds) ?? []);
    const turns = optimistic ? [...(detail?.turns.filter(turn => turn.id !== optimistic.id && turn.requestId !== optimistic.requestId) ?? []), optimistic] : detail?.turns ?? [];
    return {items, detail, turns, uploads, attachments: detail?.attachments.filter(file => !used.has(file.id)) ?? [], activity, error, blocked,
        busy: activity === 'sending' || turns.some(turn => turn.status === 'pending'), send, retry, stop, stopOwn, select, refresh, newChat, rename, remove, editFailed,
        addFiles, cancelUploads, removeUpload, retryUpload, removeAttachment, captureOwner};
}
