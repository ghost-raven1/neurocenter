import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { systemRolesApi } from '../SystemRoles/api';
import { pendingRole, type RoleOverview, type RoleSelection, type SystemRoleId } from '../SystemRoles/types';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { systemRoleChatsApi as api } from './api';
import { clearServiceIntent, saveServiceIntent, serviceIntent, serviceIntentScope, serviceReceipt, legacyRoleIntentScope } from './intent';
import type { ServiceDetail, ServiceDialog, ServiceIntent, ServicePreview, ServiceReceipt, ServiceTurn } from './types';
import {useTabWatch} from '../TabNotifications/useTabWatch';
import {serviceTabSnapshot, serviceTabSource} from '../TabNotifications/snapshots';
import {tabNotifications} from '../TabNotifications/tracker';

interface Prepared extends ServicePreview { agentId: SystemRoleId; dialogId: string; model: { id: string; pin: string }; }
interface ChatState { owner: object; overview?: RoleOverview; dialogs: ServiceDialog[]; detail?: ServiceDetail; prepared?: Prepared; error: string; busy: boolean; loading: boolean; receipt?: ServiceReceipt; }
interface Options {agentId?: SystemRoleId; transport?: typeof api; origin?: string; suspended?: boolean; onAccepted?: (turn: ServiceTurn) => void;}
const statusOf = (cause: unknown): number | undefined => (cause as { response?: { status?: number } })?.response?.status;
const rejected = (cause: unknown): boolean => { const status = statusOf(cause); return !!status && status >= 400 && status < 500 && ![408, 429].includes(status); };

/** Every callback owns one mount/scope generation; lost ACKs retain the original immutable request. */
export function useSystemRoleChat(projectId: string | undefined, enabled: boolean, options: Options = {}) {
    const { scope, captureOwner } = useAuthRequestOwner();
    const oldScope = serviceIntentScope(scope, projectId, options.origin);
    const roleScope = options.agentId ? serviceIntentScope(scope, projectId, JSON.stringify(['role-chat', options.agentId])) : oldScope;
    const intentScope = !serviceReceipt(roleScope) && options.agentId ? legacyRoleIntentScope(scope, projectId, options.agentId) ?? roleScope : roleScope, transport = options.transport ?? api;
    const identity = JSON.stringify([scope, projectId ?? null, options.origin, options.agentId, intentScope, !!options.suspended]);
    const onAccepted = useRef(options.onAccepted); onAccepted.current = options.onAccepted;
    const owner = useMemo(() => ({ active: false, generation: 0 }), [identity]), currentOwner = useRef(owner); currentOwner.current = owner;
    const allowed = useRef(enabled); allowed.current = enabled;
    const empty = (): ChatState => ({ owner, dialogs: [], error: '', busy: false, loading: true });
    const [state, setState] = useState<ChatState>(empty), current = useRef(state);
    current.current = state.owner === owner ? state : empty();
    const activeDetail = current.current.detail;
    useTabWatch(scope, activeDetail && activeDetail.dialog.projectId === (projectId ?? null) ? [serviceTabSnapshot(activeDetail)] : []);
    const busy = useRef(false), reads = useRef(0), previews = useRef(0), draftDialog = useRef<string>();
    const capture = (): (() => boolean) => {
        const auth = captureOwner(), generation = owner.generation;
        return () => auth() && owner.active && owner.generation === generation && currentOwner.current === owner;
    };
    const update = (patch: Partial<ChatState>): void => {
        current.current = { ...current.current, ...patch, owner };
        setState(previous => ({ ...previous, ...patch, owner }));
    };
    const accept = (dialogId: string, turn: ServiceTurn): void => {
        const selected = current.current.detail;
        if (selected?.dialog.id === dialogId) update({ detail: { ...selected, turns: [...selected.turns.filter(item => item.id !== turn.id), turn].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) } });
    };
    const forget = (): void => { clearServiceIntent(intentScope); update({ receipt: undefined }); };
    const refresh = async (): Promise<void> => {
        const owns = capture(); if (!owns()) return;
        const sequence = ++reads.current, dialogId = current.current.detail?.dialog.id;
        const result = await Promise.allSettled([systemRolesApi.overview(projectId), transport.list(projectId), ...(dialogId ? [transport.read(dialogId)] : [])]);
        if (!owns() || sequence !== reads.current) return;
        const [overview, dialogs, detail] = result;
        const patch: Partial<ChatState> = { loading: false };
        if (overview.status === 'fulfilled') patch.overview = overview.value as RoleOverview;
        if (dialogs.status === 'fulfilled') patch.dialogs = dialogs.value as ServiceDialog[];
        if (detail?.status === 'fulfilled' && current.current.detail?.dialog.id === dialogId) {
            patch.detail = detail.value as ServiceDetail;
            const receipt = serviceReceipt(intentScope);
            if (receipt && receipt.dialogId === dialogId && patch.detail.turns.some(turn => turn.id === receipt.requestId)) { clearServiceIntent(intentScope); patch.receipt = undefined; }
        }
        patch.error = result.some(item => item.status === 'rejected') ? 'Часть данных не обновилась. История и введённая задача сохранены. Повторите чтение.' : '';
        update(patch);
    };
    const perform = async <T,>(work: () => Promise<T>, take: (value: T) => void, fallback: string): Promise<void> => {
        const owns = capture(); if (!owns() || busy.current) return;
        busy.current = true; update({ busy: true, error: '' });
        try { const result = await work(); if (owns()) take(result); }
        catch (cause) { if (owns()) update({ error: errorMessage(cause, fallback) }); }
        finally { if (owns()) { busy.current = false; update({ busy: false }); } }
    };
    const recover = async (): Promise<void> => {
        const receipt = serviceReceipt(intentScope); if (!receipt) return;
        const owns = capture();
        await perform(async () => {
            try {
                const turn = await transport.request(receipt.dialogId, receipt.requestId);
                if (!owns()) return undefined;
                return { turn, detail: await transport.read(receipt.dialogId) };
            }
            catch (cause) {
                if (owns() && statusOf(cause) === 404) throw new Error('Сервер пока не подтвердил запрос. Повторите чтение или тот же сохранённый запрос. Новая отправка остаётся заблокирована.');
                throw cause;
            }
        }, result => { if (result) { update({ detail: result.detail }); accept(receipt.dialogId, result.turn); forget(); onAccepted.current?.(result.turn); void refresh(); } }, 'Принятие запроса пока не подтверждено. Повторите проверку: нового вызова модели она не создаёт.');
    };
    useEffect(() => {
        if (options.suspended) {owner.active = false; current.current = {...empty(), loading: false}; setState(current.current); return;}
        owner.active = true; owner.generation++; busy.current = false; reads.current++; previews.current++; draftDialog.current = undefined;
        const receipt = serviceReceipt(intentScope); const initial = { ...empty(), receipt }; current.current = initial; setState(initial);
        void refresh(); if (receipt) void recover();
        return () => { owner.active = false; owner.generation++; reads.current++; previews.current++; };
    }, [owner, identity, captureOwner]);
    useEffect(() => {
        if (!current.current.detail?.turns.some(turn => pendingRole(turn.run))) return;
        const timer = window.setInterval(() => { if (!busy.current && document.visibilityState !== 'hidden') void refresh(); }, 2500);
        return () => window.clearInterval(timer);
    }, [owner, state.detail?.dialog.id, state.detail?.turns.some(turn => pendingRole(turn.run))]);
    const invalidate = (): void => { if (!capture()()) return; previews.current++; update({ prepared: undefined }); };
    const select = async (dialogId: string): Promise<void> => {
        if (!capture()() || busy.current) return; reads.current++; invalidate();
        await perform(() => transport.read(dialogId), detail => {
            if (detail.dialog.projectId !== (projectId ?? null)) { update({ error: 'Диалог относится к другому проекту. Обновите историю.' }); return; }
            update({ detail });
        }, 'Диалог не открылся. Сохранённая история доступна после повторного чтения.');
    };
    const prepare = async (agentId: SystemRoleId, selection: RoleSelection, includeContext: boolean, modelId: string): Promise<void> => {
        if (!allowed.current || !capture()() || busy.current || serviceReceipt(intentScope) || options.agentId && (agentId !== options.agentId || current.current.detail?.dialog.legacy)) return;
        const model = current.current.overview?.models.find(item => item.id === modelId); if (!model) return;
        const selectedModel = { id: model.id, pin: model.pin };
        const owns = capture(), sequence = ++previews.current;
        let dialogId = current.current.detail?.dialog.id ?? (draftDialog.current ??= crypto.randomUUID());
        update({ prepared: undefined });
        await perform(async () => {
            if (!current.current.detail) {
                const dialog = await transport.create({ id: dialogId, title: selection.instruction.trim().slice(0, 60), projectId: projectId ?? null, agentId });
                if (!owns() || !allowed.current || sequence !== previews.current) return undefined;
                dialogId = dialog.id; draftDialog.current = dialog.id; update({ detail: { dialog, turns: [] } });
            }
            if (!owns() || !allowed.current || sequence !== previews.current) return undefined;
            return transport.prepare(dialogId, agentId, selection, includeContext);
        }, result => {
            if (!result || sequence !== previews.current || !allowed.current) return;
            if (current.current.overview?.models.find(item => item.id === selectedModel.id)?.pin !== selectedModel.pin) { update({ error: 'Модель изменилась. Проверьте её и подготовьте контекст заново.' }); return; }
            update({ prepared: { ...result, dialogId, agentId, model: selectedModel } });
        }, 'Контекст не подготовлен. Задача и выбранные параметры сохранены.');
    };
    const send = async (intent: ServiceIntent, replay = false): Promise<void> => {
        const owns = capture(); if (!owns() || !allowed.current || busy.current) return;
        reads.current++;
        try { saveServiceIntent(intentScope, intent); }
        catch (cause) { update({ error: errorMessage(cause, 'Не удалось сохранить запрос для восстановления. Уменьшите контекст и повторите подготовку.') }); return; }
        update({ receipt: { dialogId: intent.dialogId, requestId: intent.input.requestId } });
        const rejectExpected = tabNotifications.expect(scope, serviceTabSource(intent.dialogId, projectId), [intent.input.requestId]);
        await perform(async () => {
            try { return await transport.start(intent.dialogId, intent.agentId, intent.input); }
            catch (cause) { if (!replay && rejected(cause)) { rejectExpected(); if (owns()) { forget(); update({ prepared: undefined }); } } throw cause; }
        }, turn => { accept(intent.dialogId, turn); forget(); update({ prepared: undefined }); onAccepted.current?.(turn); void refresh(); }, 'Подтверждение отправки потеряно. Проверьте сохранённый запрос перед следующей задачей.');
    };
    const start = async (modelId: string): Promise<void> => {
        const prepared = current.current.prepared, model = current.current.overview?.models.find(item => item.id === modelId);
        if (!capture()() || !allowed.current || busy.current || serviceReceipt(intentScope) || !prepared || !model) return;
        if (prepared.model.id !== model.id || prepared.model.pin !== model.pin) { update({ prepared: undefined, error: 'Модель изменилась после подготовки. Проверьте контекст и подтвердите отправку заново.' }); return; }
        await send({ dialogId: prepared.dialogId, agentId: prepared.agentId, input: { ...prepared.selection, requestId: crypto.randomUUID(), modelId: model.id,
            expectedModelPin: prepared.model.pin, expectedDefinitionPin: prepared.prepared.definitionPin, consentDigest: prepared.prepared.consentDigest } });
    };
    const action = async (turn: ServiceTurn, action: 'cancel' | 'apply' | 'rollback'): Promise<void> => {
        const selected = current.current.detail, run = turn.run;
        if (!capture()() || busy.current || !selected || !run || !selected.turns.some(item => item.id === turn.id && item.run?.revision === run.revision)
            || action === 'apply' && !allowed.current || action === 'cancel' && !run.canCancel || action === 'apply' && !run.canApply || action === 'rollback' && !run.canRollback) return;
        reads.current++;
        const rejectExpected = tabNotifications.expect(scope, serviceTabSource(selected.dialog.id, projectId), [turn.id]);
        await perform(async () => {
            try {return await (action === 'cancel' ? transport.cancel(selected.dialog.id, turn, crypto.randomUUID()) : systemRolesApi.action(run, action, crypto.randomUUID()).then(value => ({ ...turn, run: value })));}
            catch (cause) {if (rejected(cause)) rejectExpected(); throw cause;}
        },
            value => { accept(selected.dialog.id, value); void refresh(); }, 'Исход действия не подтверждён. Перечитайте состояние перед повтором.');
    };
    const value = state.owner === owner ? state : empty();
    return { ...value, refresh, select, prepare, start, action, recover, invalidate,
        newDialog: (): void => { if (!capture()() || busy.current || serviceReceipt(intentScope)) return; draftDialog.current = undefined; invalidate(); update({ detail: undefined, error: '' }); },
        replay: async (): Promise<void> => { const intent = serviceIntent(intentScope); if (intent && capture()() && allowed.current) await send(intent, true); },
        canReplay: !!value.receipt && !!serviceIntent(intentScope),
        receiptAgentId: serviceIntent(intentScope)?.agentId,
        pendingIntent: value.receipt ? serviceIntent(intentScope) : undefined,
    };
}
