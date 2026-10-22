import {isAxiosError} from 'axios';
import {useEffect, useRef, useState} from 'react';
import type {OpenCodeProviderJobKind} from '../../../../services/shared/opencode-providers.cjs';
import {errorMessage} from '../../common/utils/errorMessage';
import {createBridgeRequestKey} from '../McpBridge/bridgeRequestKey';
import type {useBridge} from '../McpBridge/useBridge';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {providerSetupApi} from './api';
import {latestProviderStatus, matchingProviderJobs, providerJob, providerJobPending, providerReport} from './model';
import type {IProviderSetupJob, IProviderSetupRequest, IProviderSetupSelection, OpenCodeProviderPreparation, OpenCodeProviderOpened} from './types';

interface IOptions {bridge: ReturnType<typeof useBridge>; selection?: IProviderSetupSelection; canRead: boolean; canWrite: boolean; writeReason: string;}
interface IAttempt {scope: string; input: IProviderSetupRequest; serial: string; unknown: boolean; accepted?: IProviderSetupJob; openAfter: boolean; preparation?: OpenCodeProviderPreparation;}
interface IView {scope: string; epoch: number; job?: IProviderSetupJob; preparation?: OpenCodeProviderPreparation; preparationJobId?: string; opened?: OpenCodeProviderOpened;}
type Extras = Pick<IProviderSetupRequest, 'preparationJobId' | 'expectedProviderSchemaDigest'>;

/** Exact public ACKs, live ownership and fresh availability fence every local-wizard continuation. */
export function useProviderSetup(options: IOptions) {
    const {scope: owner, captureOwner} = useAuthRequestOwner();
    const scope = JSON.stringify([owner, options.selection]), context = useRef({scope, epoch: 0});
    const attemptOwner = useRef(owner);
    const attempts = useRef(new Map<string, IAttempt>()), active = useRef<IAttempt>(), consumed = useRef(new Set<string>());
    if (attemptOwner.current !== owner) {attemptOwner.current = owner; attempts.current.clear();}
    if (context.current.scope !== scope) {context.current = {scope, epoch: context.current.epoch + 1}; active.current = undefined; consumed.current.clear();}
    const epoch = context.current.epoch, mounted = useRef(true), lock = useRef(false), latest = useRef(options); latest.current = options;
    const [view, setView] = useState<IView>({scope, epoch}), [busy, setBusy] = useState(false), [error, setError] = useState(''), [unknown, setUnknown] = useState(false);
    const currentView = view.scope === scope && view.epoch === epoch, visible = currentView ? view : {scope, epoch};
    useEffect(() => {mounted.current = true; lock.current = false; setView({scope, epoch}); setBusy(false); setError(''); setUnknown([...attempts.current.values()].some(item => item.scope === scope && item.unknown));
        return () => {mounted.current = false;};}, [scope, epoch]);
    const ownsContext = () => {const owns = captureOwner(); return () => mounted.current && owns() && context.current.scope === scope && context.current.epoch === epoch;};
    const markUnknown = () => setUnknown([...attempts.current.values()].some(item => item.scope === scope && item.unknown));
    const send = async (kind: OpenCodeProviderJobKind, extras: Extras = {}, openAfter = false, preparation?: OpenCodeProviderPreparation): Promise<void> => {
        const current = ownsContext(), live = latest.current;
        if (!current() || lock.current || !live.selection || !live.canRead || providerJobPending(active.current?.accepted)
            || matchingProviderJobs(live.bridge.jobsReady ? live.bridge.jobs : [], live.selection).some(providerJobPending)) return;
        if (kind !== 'get-opencode-provider-status' && !live.canWrite) {setError(live.writeReason); return;}
        const draft = {...live.selection, kind, ...extras}, serial = JSON.stringify(draft);
        const unresolved = [...attempts.current.values()].find(item => item.scope === scope && item.unknown);
        if (kind !== 'get-opencode-provider-status' && unresolved && unresolved.serial !== serial) {setError('Сначала подтвердите исходный запрос кнопкой «Повторить запрос». Проверка готовности остаётся доступной.'); return;}
        let saved = attempts.current.get(serial);
        const wasUnknown = saved?.unknown === true;
        lock.current = true; setBusy(true); setError('');
        try {
            if (!saved) {saved = {scope, input: {...draft, requestKey: createBridgeRequestKey()} as IProviderSetupRequest, serial, unknown: true, openAfter, preparation}; attempts.current.set(serial, saved);}
            active.current = saved;
            const raw = await providerSetupApi.create(saved.input);
            if (!current()) return;
            const accepted = providerJob(raw, saved.input, saved.preparation);
            if (!accepted) {saved.unknown = true; throw new Error('Сервер вернул неполное или чужое подтверждение. Повторите исходный запрос: его ключ сохранён.');}
            saved.accepted = accepted; saved.unknown = false;
            setView(previous => ({...(previous.scope === scope && previous.epoch === epoch ? previous : {scope, epoch}), job: accepted,
                ...(kind === 'open-opencode-provider' ? {opened: undefined} : {})}));
            markUnknown();
            void live.bridge.reload().catch(() => {if (current()) setError('Задание принято, но очередь не обновилась. Перечитайте состояние.');});
        } catch (cause) {
            if (!current()) return;
            const definitive = isAxiosError(cause) && [400, 403, 409].includes(cause.response?.status ?? 0);
            if (saved) {
                if (definitive && !wasUnknown && !saved.accepted) attempts.current.delete(serial);
                else saved.unknown = true;
                active.current = undefined; markUnknown();
            }
            setError(errorMessage(cause, 'Ответ не получен. Повторите исходный запрос или проверьте готовность.'));
        } finally {if (current()) {lock.current = false; setBusy(false);}}
    };
    const currentSend = useRef(send); currentSend.current = send;
    const queue = matchingProviderJobs(options.bridge.jobsReady ? options.bridge.jobs : [], options.selection);
    const observed = active.current?.accepted;
    const fromQueue = options.bridge.jobsReady && observed ? options.bridge.jobs.find(item => item.id === observed.id) : undefined;
    const job = fromQueue && active.current ? providerJob(fromQueue, active.current.input, active.current.preparation) ?? observed : observed ?? queue.find(providerJobPending) ?? visible.job;
    const processJob = useRef<(value: IProviderSetupJob) => void>(() => undefined);
    processJob.current = value => {
        const current = ownsContext(), saved = active.current;
        if (!current() || !saved || saved.accepted?.id !== value.id || providerJobPending(value) || consumed.current.has(value.id)) return;
        if (value.state !== 'succeeded') {
            consumed.current.add(value.id); attempts.current.delete(saved.serial); active.current = undefined; markUnknown();
            setView(previous => ({...previous, job: value})); setError('Задание не завершено. Проверьте подключение и повторите действие.'); return;
        }
        const report = providerReport(value, saved.input, saved.preparation?.preparationId);
        if (!report) {saved.unknown = true; active.current = undefined; markUnknown(); setError('Результат не подтверждает выбранную настройку. Сохранён исходный ключ запроса.'); return;}
        consumed.current.add(value.id); attempts.current.delete(saved.serial); active.current = undefined; markUnknown();
        setView(previous => ({...previous, job: value, ...(saved.input.kind === 'prepare-opencode-provider' ? {preparation: report as OpenCodeProviderPreparation, preparationJobId: value.id}
            : saved.input.kind === 'open-opencode-provider' ? {opened: report as OpenCodeProviderOpened} : {})}));
        if (saved.input.kind === 'prepare-opencode-provider' && saved.openAfter) {
            const prepared = report as OpenCodeProviderPreparation;
            if (Date.parse(prepared.expiresAt) <= Date.now()) {setError('Подготовка истекла. Откройте мастер заново.'); return;}
            void currentSend.current('open-opencode-provider', {preparationJobId: value.id, expectedProviderSchemaDigest: prepared.schemaDigest}, false, prepared);
        }
    };
    useEffect(() => {if (job && !busy) processJob.current(job);}, [job, busy]);
    const statusJobs = [...queue, ...(job && !queue.some(item => item.id === job.id) ? [job] : [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const changing = [...attempts.current.values()].some(item => item.scope === scope && item.input.kind !== 'get-opencode-provider-status');
    const status = options.canRead && options.bridge.jobsReady && !changing ? latestProviderStatus(statusJobs, options.selection) : undefined;
    const open = (): void => {void send('prepare-opencode-provider', {}, true);};
    return {job, preparation: visible.preparation, opened: options.canRead && visible.opened && Date.parse(visible.opened.expiresAt) > Date.now() ? visible.opened : undefined, status, busy: currentView && busy,
        retryRequiresWrite: [...attempts.current.values()].find(item => item.scope === scope && item.unknown)?.input.kind !== 'get-opencode-provider-status',
        pending: providerJobPending(job), error: currentView ? error : '', unknown: currentView && unknown, open, check: () => {void send('get-opencode-provider-status');},
        retry: () => {const saved = [...attempts.current.values()].find(item => item.scope === scope && item.unknown); if (saved) void send(saved.input.kind,
            {preparationJobId: saved.input.preparationJobId, expectedProviderSchemaDigest: saved.input.expectedProviderSchemaDigest}, saved.openAfter, saved.preparation);},
        reload: () => {const current = ownsContext(); void latest.current.bridge.reload().catch(() => {if (current()) setError('Не удалось перечитать очередь. Повторите попытку.');});}};
}
