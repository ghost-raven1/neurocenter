import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { roleOperationTabSnapshot } from '../TabNotifications/snapshots';
import { tabNotifications } from '../TabNotifications/tracker';
import { useTabWatch } from '../TabNotifications/useTabWatch';
import { systemRolesApi } from './api';
import { pendingRole, type RoleOverview, type RolePrepared, type RoleRun, type RoleSelection, type RoleStart, type SystemRoleId } from './types';

/** Accepted intents keep their request key on an unknown ACK; refresh/history never invokes a model. */
export function useSystemRole(id: SystemRoleId, projectId?: string, initialRunId?: string) {
    const { scope, captureOwner } = useAuthRequestOwner(), identity = JSON.stringify([scope, id, projectId, initialRunId]), currentIdentity = useRef(identity); currentIdentity.current = identity;
    const [overview, setOverview] = useState<RoleOverview>(), [history, setHistory] = useState<RoleRun[]>([]), [run, setRun] = useState<RoleRun | null>(null);
    const [prepared, setPrepared] = useState<RolePrepared>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
    const sequence = useRef(0), busyRef = useRef(false), intent = useRef<{ input: RoleStart; identity: string }>(), dataIdentity = useRef(identity), knownRejection = useRef(false);
    const current = dataIdentity.current === identity;
    useTabWatch(scope, current && run?.agentId === id && run.projectId === (projectId ?? null) && run.operationId ? [roleOperationTabSnapshot(run)] : []);
    const capture = () => { const owns = captureOwner(), owner = identity; return () => owns() && currentIdentity.current === owner; };
    const refresh = useCallback(async () => {
        const owns = captureOwner(), owner = identity, generation = ++sequence.current;
        if (!owns()) return;
        try {
            const [catalog, items] = await Promise.allSettled([systemRolesApi.overview(projectId), systemRolesApi.list(id, projectId)]);
            if (owns() && currentIdentity.current === owner && sequence.current === generation) {
                if (catalog.status === 'fulfilled') setOverview(catalog.value);
                if (items.status === 'fulfilled') { setHistory(items.value); setRun(previous => items.value.find(item => item.id === previous?.id) ?? previous); }
                setError(catalog.status === 'rejected' || items.status === 'rejected' ? 'Часть данных не обновилась. Сохранённая история и введённое остаются доступны.' : '');
            }
        } catch (cause) { if (owns() && currentIdentity.current === owner && sequence.current === generation) setError(errorMessage(cause, 'История не обновилась. Введённые данные сохранены.')); }
    }, [captureOwner, identity, projectId, id]);
    useEffect(() => { dataIdentity.current = identity; setOverview(undefined); setHistory([]); setRun(null); setPrepared(undefined); setError(''); setBusy(false); setUncertain(false); busyRef.current = false; intent.current = undefined;
        void refresh(); return () => { sequence.current++; }; }, [refresh]);
    useEffect(() => {
        if (!initialRunId) return; const owns = captureOwner(), owner = identity;
        void systemRolesApi.get(id, initialRunId).then(item => {
            if (owns() && currentIdentity.current === owner) { setRun(item); setHistory(items => [item, ...items.filter(old => old.id !== item.id)].slice(0, 20)); }
        }).catch(() => { if (owns() && currentIdentity.current === owner) setError('Не удалось прочитать выбранный запуск. Проверьте текущий доступ и повторите чтение.'); });
    }, [id, initialRunId, identity, captureOwner]);
    useEffect(() => { if (!pendingRole(run)) return; const timer = window.setInterval(() => { if (!busyRef.current && document.visibilityState !== 'hidden') void refresh(); }, 2500); return () => clearInterval(timer); }, [run?.state, refresh]);
    const perform = async <T,>(work: () => Promise<T>, accept: (value: T) => void, fallback: string): Promise<T | undefined> => {
        if (busyRef.current) return; const owns = capture(); if (!owns()) return; busyRef.current = true; knownRejection.current = false; setBusy(true); setError('');
        try { const value = await work(); if (owns()) accept(value); return owns() ? value : undefined; }
        catch (cause) { if (owns()) { const status = (cause as {response?:{status?:number}})?.response?.status;
            knownRejection.current = !!status && status >= 400 && status < 500 && ![408,429].includes(status); setError(errorMessage(cause, fallback)); } return undefined; }
        finally { if (owns()) { busyRef.current = false; setBusy(false); } }
    };
    const prepare = async (selection: RoleSelection) => perform(() => systemRolesApi.prepare(id, selection), setPrepared, 'Контекст не подготовлен. Сохраните выбор и повторите.');
    const send = async (input: RoleStart) => {
        if (busyRef.current) return; const owns = capture();
        const value = await perform(() => systemRolesApi.start(id, input), item => {
            if (item.agentId === id && item.projectId === (projectId ?? null) && item.operationId && pendingRole(item)) {
                const snapshot = roleOperationTabSnapshot(item); tabNotifications.expect(scope, snapshot.source, [item.operationId]); tabNotifications.accept(scope, snapshot);
            }
            setRun(item); setHistory(items => [item, ...items.filter(old => old.id !== item.id)].slice(0, 20)); intent.current = undefined; setUncertain(false);
        },
            'Запуск не подтверждён. Повторите тот же запрос или перечитайте историю.');
        if (!value && owns()) { if (knownRejection.current) { intent.current = undefined; setUncertain(false); } else setUncertain(true); }
    };
    return { overview: current ? overview : undefined, history: current ? history : [], run: current ? run : null, prepared: current ? prepared : undefined,
        error: current ? error : '', busy: current && busy, uncertain: current && uncertain, refresh,
        invalidate: () => setPrepared(undefined), prepare,
        start: async (input: RoleStart) => { if (intent.current || busyRef.current || !capture()()) return; intent.current = { input, identity }; await send(input); },
        replay: async () => { const saved = intent.current; if (saved?.identity === identity) await send(saved.input); },
        select: (item: RoleRun) => { setRun(item); setError(''); },
        action: async (action: 'cancel' | 'apply' | 'rollback') => {
            if (!run || !current || busyRef.current || !capture()()) return;
            const rejectExpected = run.operationId && run.agentId === id && run.projectId === (projectId ?? null)
                ? tabNotifications.expect(scope, roleOperationTabSnapshot(run).source, [run.operationId]) : () => undefined;
            await perform(async () => {
                try {return await systemRolesApi.action(run, action, crypto.randomUUID());}
                catch (cause) {const status = (cause as {response?:{status?:number}})?.response?.status; if (status && status >= 400 && status < 500 && ![408,429].includes(status)) rejectExpected(); throw cause;}
            }, item => { setRun(item); void refresh(); }, 'Исход действия не подтверждён. Перечитайте состояние перед следующим действием.');
        },
    };
}
