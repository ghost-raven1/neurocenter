import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { bridgeApi, type IBridgeJobDraft } from './api';
import type { IWorkspacePreparation, TWorkspaceBindingMode } from './operationTypes';
import type { useBridge } from './useBridge';
import { useLocalJob } from './useLocalJob';
import { isPending } from './installationHelpers';
import { workspaceBlocker } from './readiness';
import { matchingWorkspacePreparation, workspaceSnapshot, workspaceSource } from './workspaceBinding';

type Draft = Extract<IBridgeJobDraft, {kind: 'prepare-bind-project' | 'bind-project'}>;
type View = {active: boolean};
interface Request {
    view: View;
    token: symbol;
    owns: () => boolean;
    input: Draft;
    snapshot: string;
    deviceName: string;
    root: string;
    sourceFolderName?: string;
    jobId?: string;
    commitInput?: Draft;
    commitJobId?: string;
}
interface Props {
    bridge: ReturnType<typeof useBridge>;
    project: {id: string; name: string};
    canManage: boolean;
    onClose(): void;
}

/** Явный выбор проверяется один раз; ответы принадлежат своему владельцу, папке и устройству. */
export function useWorkspaceBinding({bridge, project, canManage, onClose}: Props) {
    const {scope, captureOwner} = useAuthRequestOwner();
    const view = useMemo<View>(() => ({active: true}), [scope, project.id, bridge.device?.id]);
    const latestView = useRef(view);
    latestView.current = view;
    const binding = bridge.device?.report.bindings?.find(item => item.projectId === project.id);
    const [draft, setDraft] = useState({view, folderName: binding?.folderName, mode: 'new' as TWorkspaceBindingMode, touched: false});
    // Нетронутый preset следует текущему отчёту; явный выбор и начатый запрос фиксируют draft.
    const selection = draft.view === view && draft.touched ? draft
        : {view, folderName: binding?.folderName, mode: 'new' as TWorkspaceBindingMode, touched: false};
    const [savedRequest, setRequest] = useState<Request>();
    const request = savedRequest?.view === view ? savedRequest : undefined;
    const requestRef = useRef(request);
    requestRef.current = request;
    const [startingView, setStartingView] = useState<View>();
    const action = useRef<{view: View; token: symbol}>();
    const closed = useRef<symbol>();
    const [notice, setNotice] = useState<{view: View; text: string}>();
    const [cancelling, setCancelling] = useState<string>();
    const [now, setNow] = useState(Date.now());
    const operation = useLocalJob(bridge);
    const latest = useRef({bridge, project, canManage, onClose});
    latest.current = {bridge, project, canManage, onClose};
    useEffect(() => {
        view.active = true;
        return () => { view.active = false; };
    }, [view]);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);

    const owned = (value: Request) => value.view.active && latestView.current === value.view
        && value.owns() && requestRef.current?.token === value.token;
    const job = (id?: string) => id ? bridge.jobs.find(item => item.id === id)
        || (operation.job?.id === id ? operation.job : undefined) : undefined;
    const prepareJob = job(request?.jobId);
    const commitJob = job(request?.commitJobId);
    const busy = startingView === view || operation.busy;
    const retryPrepare = !busy && !!request && !request.jobId && operation.canRetry(request.input);
    const retryCommit = !busy && !!request?.commitInput && !request.commitJobId && operation.canRetry(request.commitInput);
    // Потерянный ACK проверки можно уточнить тем же ключом; мутации и выбор root остаются блокирующими.
    const pendingFor = (live = latest.current, retrying = retryPrepare) => live.bridge.jobs.find(item =>
        item.deviceId === live.bridge.device?.id && isPending(item)
        && (item.kind === 'choose-root' || item.projectId === live.project.id)
        && item.id !== requestRef.current?.jobId && item.id !== requestRef.current?.commitJobId
        && !(retrying && item.kind === 'prepare-bind-project' && item.projectId === live.project.id));
    const otherPending = pendingFor();
    const orphanPrepare = retryPrepare ? pendingFor(latest.current, false) : undefined;
    const pendingJob = [commitJob, prepareJob, otherPending, orphanPrepare].find(isPending);
    const locked = busy || isPending(prepareJob) || isPending(commitJob);
    // Неопределённая проверка только читает папку: новый явный выбор может отозвать её preview.
    const selectionLocked = locked || retryCommit;
    const readError = bridge.errors.devices || bridge.errors.jobs;
    const blocker = !canManage ? 'Для привязки нужна роль разработчика в этом проекте.' : workspaceBlocker(bridge.device)
        || readError || (!bridge.devicesReady || !bridge.jobsReady ? 'Дождитесь актуальных данных компьютера и очереди.' : '');
    const stale = !!request && request.snapshot !== workspaceSnapshot(bridge.device, project.id);
    const preparation: IWorkspacePreparation | undefined = request && prepareJob?.state === 'succeeded'
        ? matchingWorkspacePreparation(prepareJob.result, request.input) : undefined;
    const expiresAt = prepareJob ? Date.parse(prepareJob.updatedAt) + 15 * 60000 : 0;
    const expired = !!preparation && (!Number.isFinite(expiresAt) || expiresAt <= now);
    const failedCommit = !!commitJob && ['failed', 'cancelled'].includes(commitJob.state);
    const sourceError = (() => {
        try { workspaceSource(binding, selection.mode); return ''; }
        catch (cause) { return (cause as Error).message; }
    })();
    const mismatch = prepareJob?.state === 'succeeded' && !preparation
        ? 'Ответ моста не соответствует выбранной папке. Повторите проверку.' : '';
    const error = notice?.view === view && notice.text || request && operation.error || mismatch || '';

    useEffect(() => {
        if (request && commitJob?.state === 'succeeded' && owned(request) && closed.current !== request.token) {
            closed.current = request.token;
            latest.current.onClose();
        }
    }, [request, commitJob?.id, commitJob?.state]);

    const begin = () => {
        const owns = captureOwner();
        if (!owns() || !view.active || latestView.current !== view || action.current?.view === view) { return; }
        const token = Symbol();
        action.current = {view, token};
        setStartingView(view);
        setNotice({view, text: ''});
        operation.setError('');
        return {
            current: () => owns() && view.active && latestView.current === view && action.current?.token === token,
            finish: () => {
                if (action.current?.token === token) {
                    action.current = undefined;
                    if (owns() && view.active && latestView.current === view) { setStartingView(undefined); }
                }
            },
        };
    };
    const canStart = (live = latest.current) => live.canManage && live.bridge.device && !workspaceBlocker(live.bridge.device)
        && live.bridge.devicesReady && live.bridge.jobsReady && !live.bridge.errors.devices && !live.bridge.errors.jobs;
    const prepare = async (folderName = selection.folderName, mode = selection.mode) => {
        const live = latest.current;
        if (!folderName || !canStart(live) || locked || pendingFor(live) || action.current?.view === view) { return; }
        const running = begin();
        if (!running) { return; }
        setDraft({view, folderName, mode, touched: true});
        try {
            const existing = requestRef.current;
            const retry = existing && operation.canRetry(existing.input);
            const source = live.bridge.device?.report.bindings?.find(item => item.projectId === live.project.id);
            const input: Draft = retry ? existing.input : {
                kind: 'prepare-bind-project', deviceId: live.bridge.device!.id,
                projectId: live.project.id, folderName, bindingMode: mode, ...workspaceSource(source, mode),
            };
            const next: Request = retry ? {...existing, token: Symbol()} : {
                view, token: Symbol(), owns: captureOwner(), input,
                snapshot: workspaceSnapshot(live.bridge.device, live.project.id),
                deviceName: live.bridge.device!.name, root: live.bridge.device!.report.root || '',
                ...(mode !== 'new' && mode !== 'resume' ? {sourceFolderName: source?.folderName} : {}),
            };
            requestRef.current = next;
            setRequest(next);
            const accepted = await operation.submit(input);
            if (running.current() && owned(next) && accepted) {
                setRequest(previous => previous?.token === next.token ? {...previous, jobId: accepted.id} : previous);
            }
        } catch (cause) {
            if (running.current()) { setNotice({view, text: cause instanceof Error ? cause.message : 'Не удалось проверить папку.'}); }
        } finally { running.finish(); }
    };
    const choose = (folderName: string | undefined, mode: TWorkspaceBindingMode) => {
        if (selectionLocked || action.current?.view === view) { return; }
        requestRef.current = undefined;
        setRequest(undefined);
        setDraft({view, folderName, mode, touched: true});
        setNotice({view, text: ''});
        operation.setError('');
        if (folderName) { void prepare(folderName, mode); }
    };
    const commit = async () => {
        const live = latest.current;
        const current = requestRef.current;
        if (!current || !owned(current) || !canStart(live) || locked || pendingFor(live, false) || action.current?.view === view) { return; }
        const retry = current.commitInput && operation.canRetry(current.commitInput);
        if (!retry && (!preparation || expired || stale || failedCommit)) { return; }
        const running = begin();
        if (!running) { return; }
        const input: Draft = retry ? current.commitInput! : {
            ...current.input, kind: 'bind-project', preparationJobId: prepareJob!.id, expectedPreparation: preparation!.preparation,
        };
        setRequest(previous => previous?.token === current.token ? {...previous, commitInput: input} : previous);
        try {
            const accepted = await operation.submit(input);
            if (running.current() && owned(current) && accepted) {
                setRequest(previous => previous?.token === current.token ? {...previous, commitJobId: accepted.id} : previous);
            }
        } catch (cause) {
            if (running.current()) { setNotice({view, text: cause instanceof Error ? cause.message : 'Не удалось подтвердить привязку.'}); }
        } finally { running.finish(); }
    };
    const cancel = async (id: string) => {
        const live = latest.current;
        const item = live.bridge.jobs.find(value => value.id === id) || (operation.job?.id === id ? operation.job : undefined);
        if (!canStart(live) || item?.state !== 'queued' || item.deviceId !== live.bridge.device?.id || busy) { return; }
        const running = begin();
        if (!running) { return; }
        setCancelling(id);
        try {
            await bridgeApi.cancel(id);
            if (running.current()) { await live.bridge.reload(); }
        } catch {
            if (running.current()) { setNotice({view, text: 'Не удалось отменить задание. Обновите данные и повторите отмену.'}); }
        } finally {
            if (running.current()) { setCancelling(undefined); }
            running.finish();
        }
    };
    const refresh = async () => {
        const owns = captureOwner();
        try { await latest.current.bridge.reload(); }
        catch {
            if (owns() && view.active && latestView.current === view) {
                setNotice({view, text: 'Не удалось обновить данные компьютера. Повторите попытку.'});
            }
        }
    };
    return {
        folderName: selection.folderName, mode: selection.mode, binding, request, preparation, expiresAt, expired, stale, failedCommit,
        busy, locked, selectionLocked, blocker, sourceError, error, otherPending, pendingJob, retryPrepare, retryCommit, cancelling,
        job: commitJob || prepareJob, chooseFolder: (folder: string) => choose(folder, selection.mode),
        chooseMode: (mode: TWorkspaceBindingMode) => choose(selection.folderName, mode), prepare: () => prepare(), commit, cancel, refresh,
    };
}
