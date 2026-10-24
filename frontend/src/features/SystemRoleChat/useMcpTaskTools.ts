import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import type { RoleMcpTarget } from '../SystemRoles/types';
import { mcpTargetKey, roleMcpApi, type RoleMcpDiscovery, type RoleMcpSources } from './mcpApi';

/** An identity object fences auth/project ABA and StrictMode replay, including retained event handlers. */
function useMcpOwner(identity: string) {
    const { scope, captureOwner } = useAuthRequestOwner();
    const owner = useMemo(() => ({ active: false, generation: 0 }), [scope, identity]), current = useRef(owner); current.current = owner;
    useEffect(() => { owner.active = true; owner.generation++; return () => { owner.active = false; owner.generation++; }; }, [owner]);
    return { owner, capture: () => { const auth = captureOwner(), generation = owner.generation; return () => auth() && owner.active && owner.generation === generation && current.current === owner; } };
}

export function useMcpTaskSources(projectId?: string) {
    const { owner, capture } = useMcpOwner(JSON.stringify([projectId ?? null])), sequence = useRef(0);
    const [state, setState] = useState<{ owner: object; data?: RoleMcpSources; error: string; loading: boolean }>({ owner, error: '', loading: true });
    const refresh = async (): Promise<void> => {
        const owns = capture(); if (!owns()) return; const request = ++sequence.current;
        if (!projectId) { setState({ owner, error: '', loading: false }); return; }
        setState(previous => ({ ...previous, owner, loading: true, error: '' }));
        try { const data = await roleMcpApi.sources(projectId); if (owns() && request === sequence.current) setState({ owner, data, error: '', loading: false }); }
        catch (cause) { if (owns() && request === sequence.current) setState(previous => ({ ...previous, owner, loading: false, error: errorMessage(cause, 'Источники MCP не загрузились. Можно продолжить задачу без инструментов.') })); }
    };
    useEffect(() => { setState({ owner, error: '', loading: true }); void refresh(); return () => { sequence.current++; }; }, [owner]);
    return { ...(state.owner === owner ? state : { data: undefined, error: '', loading: true }), refresh, capture };
}

/** POST discovery is explicit; polling and ACK recovery only read the same request ID. */
export function useMcpTaskDiscovery(projectId: string | undefined, target: RoleMcpTarget, enabled: boolean, initialId?: string) {
    const identity = mcpTargetKey(target), { owner, capture } = useMcpOwner(JSON.stringify([projectId ?? null, identity]));
    const allowed = useRef(enabled); allowed.current = enabled;
    const lock = useRef(false), currentId = useRef(initialId), discovered = useRef<RoleMcpDiscovery>();
    const [state, setState] = useState<{ owner: object; discovery?: RoleMcpDiscovery; requestId?: string; error: string; busy: boolean }>({ owner, requestId: initialId, error: '', busy: false });
    const perform = async (read: boolean): Promise<void> => {
        const owns = capture(); if (!owns() || lock.current || !read && (!allowed.current || !projectId)) return;
        const id = currentId.current ?? (read ? undefined : crypto.randomUUID()); if (!id) return;
        if (!read) discovered.current = undefined;
        currentId.current = id; lock.current = true; setState(previous => ({ ...previous, owner, requestId: id, busy: true, error: '' }));
        try {
            const discovery = await (read ? roleMcpApi.read(id) : roleMcpApi.discover(projectId, target, id));
            if (!owns()) return;
            if (mcpTargetKey(discovery.target) !== identity || discovery.id !== id) throw new Error('Источник инструментов изменился. Выберите его заново.');
            discovered.current = discovery;
            setState({ owner, requestId: id, discovery, error: '', busy: false });
        } catch (cause) { if (owns()) setState(previous => ({ ...previous, owner, busy: false, error: errorMessage(cause, 'Список инструментов не подтверждён. Проверьте тот же запрос или продолжите без MCP.') })); }
        finally { if (owns()) lock.current = false; }
    };
    useEffect(() => {
        lock.current = false; discovered.current = undefined; currentId.current = initialId; setState({ owner, requestId: initialId, error: '', busy: false }); if (initialId) void perform(true);
    }, [owner]);
    useEffect(() => {
        if (state.owner !== owner || state.discovery?.state !== 'pending') return;
        const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void perform(true); }, 1500);
        return () => window.clearInterval(timer);
    }, [owner, state.discovery?.state]);
    return { ...(state.owner === owner ? state : { discovery: undefined, requestId: undefined, error: '', busy: false }), capture,
        canSelect: (id: string): boolean => capture()() && !lock.current && discovered.current?.id === id && discovered.current.state === 'ready',
        read: (): Promise<void> => perform(true),
        discover: async (): Promise<void> => {
            if (!capture()() || lock.current || !allowed.current) return;
            if (state.discovery && state.discovery.state !== 'pending') currentId.current = undefined;
            await perform(false);
        } };
}
