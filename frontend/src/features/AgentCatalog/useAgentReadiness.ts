import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { createAgentRequestKeys } from './requestKeys';
import { agentReadinessApi } from './readinessApi';
import { agentTrialPending, reconcileAgentTrial } from './readinessModel';
import type { IAgentReadiness, IAgentReadinessItem, IAgentTrial, IAgentTrialStart, TAgentTrialTool } from './readinessTypes';

interface IState { context: string; data: IAgentReadiness | null; loading: boolean; error: string; busy: boolean; uncertain: boolean; }
interface IRetry { context: string; agentId: string; input: IAgentTrialStart; }
const empty = (context: string): IState => ({ context, data: null, loading: false, error: '', busy: false, uncertain: false });

/** Only explicit actions start trials; owner changes abort reads and discard late mutation acknowledgements. */
export function useAgentReadiness(projectId: string | undefined, canRead: boolean, projectRevision: number | null) {
    const { scope, captureOwner } = useAuthRequestOwner();
    const availability = useFeatureAvailability('agents', 'group_chat', 'model_chat', 'model_hosting');
    const searchAvailability = useFeatureAvailability('project_search');
    const context = JSON.stringify([scope, projectId, canRead]);
    const current = useRef(context); current.current = context;
    const catalogRevision = useRef(projectRevision); catalogRevision.current = projectRevision;
    const lastCatalog = useRef({ context, revision: projectRevision });
    const [stored, setStored] = useState<IState>(() => empty(context));
    const state = stored.context === context ? stored : empty(context);
    const requests = useRef(new Set<AbortController>()), generation = useRef(0), lock = useRef<symbol>();
    const keys = useRef(createAgentRequestKeys()), retry = useRef<IRetry>();
    const ownsContext = useCallback(() => { const owns = captureOwner(); return () => owns() && current.current === context; }, [captureOwner, context]);
    const controller = (): AbortController => { const value = new AbortController(); requests.current.add(value); return value; };
    const refresh = useCallback(async (): Promise<IAgentReadiness | null> => {
        if (!projectId || !canRead) return null;
        const owns = ownsContext(); if (!owns()) return null;
        const request = ++generation.current, abort = controller();
        setStored(previous => previous.context === context ? { ...previous, loading: true } : { ...empty(context), loading: true });
        try {
            const data = await agentReadinessApi.list(projectId, abort.signal);
            if (!owns() || abort.signal.aborted || generation.current !== request) return null;
            const saved = retry.current;
            const confirmed = saved?.context === context && data.items.some(item => item.agentId === saved.agentId && item.latestTrial?.requestId === saved.input.requestId);
            if (confirmed) retry.current = undefined;
            setStored(previous => ({ ...(previous.context === context ? previous : empty(context)), data, loading: false, error: '',
                ...(confirmed ? { uncertain: false } : {}) }));
            return data;
        } catch (cause) {
            if (owns() && !abort.signal.aborted && generation.current === request) setStored(previous => ({ ...(previous.context === context ? previous : empty(context)), loading: false,
                error: errorMessage(cause, 'Не удалось перечитать испытания. Предыдущий результат сохранён.') }));
            return null;
        } finally { requests.current.delete(abort); }
    }, [projectId, canRead, context, ownsContext]);
    useEffect(() => {
        setStored(empty(context)); retry.current = undefined; keys.current.clear(); lock.current = undefined;
        void refresh();
        return () => { generation.current++; for (const abort of requests.current) abort.abort(); requests.current.clear(); };
    }, [context, refresh]);
    useEffect(() => {
        const previous = lastCatalog.current; lastCatalog.current = { context, revision: projectRevision };
        if (previous.context === context && previous.revision !== projectRevision && projectRevision !== null) void refresh();
    }, [context, projectRevision, refresh]);
    const pending = state.data?.items.some(item => agentTrialPending(item.latestTrial)) ?? false;
    useEffect(() => {
        if (!pending) return;
        const timer = window.setInterval(() => { if (!requests.current.size && document.visibilityState !== 'hidden') void refresh(); }, 3000);
        return () => window.clearInterval(timer);
    }, [pending, refresh]);
    useSectionUpdates(['catalog', 'projects', 'access'], () => { void refresh(); }, !!projectId && canRead);

    const saveTrial = (agentId: string, trial: IAgentTrial): void => {
        generation.current++;
        setStored(previous => previous.context !== context ? previous : { ...previous, data: previous.data && { ...previous.data,
            items: previous.data.items.map(item => item.agentId === agentId ? { ...item, latestTrial: reconcileAgentTrial(item, trial) } : item) } });
    };
    const run = async (operation: (signal: AbortSignal) => Promise<IAgentTrial>, agentId: string, start?: IRetry): Promise<IAgentTrial | null> => {
        const owns = ownsContext(); if (!owns() || !projectId || !canRead || lock.current) return null;
        const token = Symbol('agent-trial'), abort = controller(); lock.current = token;
        setStored(previous => ({ ...(previous.context === context ? previous : empty(context)), busy: true, error: '' }));
        try {
            const trial = await operation(abort.signal);
            if (!owns() || abort.signal.aborted) return null;
            if (start && trial.requestId !== start.input.requestId) throw new Error('Сервер не подтвердил ключ этого запуска. Перечитайте состояние или повторите тот же запрос.');
            if (retry.current?.context === context && retry.current.input.requestId === trial.requestId) retry.current = undefined;
            saveTrial(agentId, trial);
            setStored(previous => previous.context === context ? { ...previous, uncertain: retry.current?.context === context } : previous);
            await refresh(); return trial;
        } catch (cause) {
            if (!owns() || abort.signal.aborted) return null;
            const status = (cause as {response?: {status?: number}})?.response?.status;
            const unconfirmedStart = !!start && (!status || status >= 500);
            if (unconfirmedStart) retry.current = start;
            setStored(previous => previous.context === context ? { ...previous, uncertain: retry.current?.context === context,
                error: errorMessage(cause, unconfirmedStart ? 'Ответ о запуске не получен. Перечитайте состояние или повторите тот же запрос.' : 'Испытание не выполнено. Перечитайте состояние и повторите действие.') } : previous);
            return null;
        } finally {
            requests.current.delete(abort);
            if (lock.current === token) { lock.current = undefined; if (owns()) setStored(previous => previous.context === context ? { ...previous, busy: false } : previous); }
        }
    };
    const start = async (item: IAgentReadinessItem, modelId: string, tool: TAgentTrialTool, toolConsent: boolean): Promise<IAgentTrial | null> => {
        if (!availability.enabled || !item.eligibility.canRun || item.projectRevision !== catalogRevision.current
            || state.uncertain || retry.current?.context === context || state.loading || !!state.error || agentTrialPending(item.latestTrial)) return null;
        const model = item.eligibility.models.find(value => value.id === modelId && value.available);
        const search = item.eligibility.tools.find(value => value.kind === 'project_search');
        if (!model || item.eligibility.modelSelection === 'fixed' && item.eligibility.resolvedModelId !== modelId
            || tool === 'project_search' && (!searchAvailability.enabled || !search?.available || search.requiresConsent && !toolConsent)) return null;
        try {
            const body = { expectedRevision: item.projectRevision, expectedAgentPin: item.currentPin, modelId, expectedModelPin: model.pin,
                tool, ...(tool === 'project_search' && search?.requiresConsent ? { toolConsent: true } : {}) };
            const input = { ...body, requestId: keys.current.forRequest('trial', { ...body, agentId: item.agentId, previousTrialId: item.latestTrial?.id }) };
            return await run(signal => agentReadinessApi.start(projectId!, item.agentId, input, signal), item.agentId, { context, agentId: item.agentId, input });
        } catch (cause) {
            if (ownsContext()()) setStored(previous => previous.context === context ? { ...previous, error: errorMessage(cause, 'Не удалось создать безопасный ключ запроса.') } : previous);
            return null;
        }
    };
    const replay = (): Promise<IAgentTrial | null> => {
        const saved = retry.current;
        if (!saved || saved.context !== context) return Promise.resolve(null);
        return run(signal => agentReadinessApi.start(projectId!, saved.agentId, saved.input, signal), saved.agentId, saved);
    };
    const cancel = (agentId: string, trial: IAgentTrial): Promise<IAgentTrial | null> => !trial.canCancel ? Promise.resolve(null)
        : run(signal => agentReadinessApi.cancel(projectId!, agentId, trial, signal), agentId);
    return { items: state.data?.items ?? [], loading: state.loading, error: state.error, busy: state.busy, uncertain: state.uncertain,
        refresh, start, replay, cancel, availability };
}
