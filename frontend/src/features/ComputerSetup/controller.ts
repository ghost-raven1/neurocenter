import {OPENCODE_CLI_INSPECT_JOB, normalizeOpenCodeCliRequest} from '@neurocenter/computer-setup';
import {OPENCODE_CLI_INSTALL_JOB,normalizeOpenCodeInstallRequest} from '@neurocenter/opencode-cli-install';
import {errorMessage} from '../../common/utils/errorMessage';
import {createBridgeRequestKey} from '../McpBridge/bridgeRequestKey';
import type {CliObservationApi} from './api';
import type {CliJournalLock} from './journalLock';
import {cliTerminal, initialCliObservation, newerCliJob, readCliJob, record, type CliIntent, type CliJob, type CliObservationState,type ComputerCliKind} from './model';
import {readCliReceipt} from './receipt';
import {cliStorageKey, readCliIntent, writeCliIntent, type CliStorage} from './storage';
import {installationReconciled} from './installationState';

interface Options {
    email: string; role: string; deviceId: string; api: CliObservationApi; storage?: CliStorage; lock?: CliJournalLock;
    captureOwner: () => () => boolean; canStart: () => boolean; canCancel: () => boolean;
    onChange: (state: CliObservationState) => void; requestKey?: () => string;
    kind?:ComputerCliKind;
}
const statusOf = (cause: unknown): number | undefined => (cause as {response?: {status?: number}} | null)?.response?.status;
const denied = (cause: unknown): boolean => [401, 403].includes(statusOf(cause) ?? 0);

/** One device journal owns admission and exact-key recovery; no network work is held under a WebLock. */
export function createCliObservationController(options: Options) {
    const kind=options.kind??OPENCODE_CLI_INSPECT_JOB,key = cliStorageKey(options.email, options.deviceId,kind);
    let state = initialCliObservation(), active = false, epoch = 0, initialized = false, attemptedAutomatic = false;
    let observed: string | null = null, abort: AbortController | undefined, receiptConfirmed = false;
    let historySnapshot:readonly unknown[]=[];
    const publish = (patch: Partial<CliObservationState>): void => {state = {...state, ...patch}; options.onChange(state);};
    const privacy = (): void => publish({job: undefined, canReplay: false, denied: true});
    function loadJournal(): boolean {
        try {
            if (!options.storage) throw Error('Хранилище браузера недоступно. Новая проверка приостановлена; историю можно читать.');
            const saved = readCliIntent(options.storage, key, options.email, options.deviceId,kind);
            if (state.intent && saved.raw === null) throw Error('Сохранённая отправка удалена в другой вкладке. Исходный запрос оставлен для проверки.');
            if (saved.intent?.request.requestKey !== state.intent?.request.requestKey) {receiptConfirmed = false; publish({job: undefined});}
            observed = saved.raw;
            publish({intent: saved.intent, storageError: '', canReplay: false}); return true;
        } catch (cause) {publish({storageError: errorMessage(cause, 'Исходная отправка не прочитана.'), canReplay: false}); return false;}
    }
    function save(value: CliIntent): boolean {
        try {
            if (!options.storage) throw Error('Хранилище браузера недоступно. Запрос не отправлен.');
            const raw = JSON.stringify(value), current = options.storage.getItem(key);
            // Another reader can acknowledge the same exact intent without replacing a different one.
            if (current !== observed && current === raw) observed = current;
            else observed = writeCliIntent(options.storage, key, value, observed);
            publish({intent: value, storageError: ''}); return true;
        } catch (cause) {publish({storageError: errorMessage(cause, 'Исходный запрос не сохранён.'), canReplay: false}); return false;}
    }
    async function run(work: (signal: AbortSignal, current: () => boolean) => Promise<void>): Promise<void> {
        const owns = options.captureOwner(); if (!active || !owns() || state.busy) return;
        const generation = epoch, transport = new AbortController(); abort = transport;
        const current = (): boolean => active && epoch === generation && owns();
        publish({busy: true, reading: true, error: ''});
        try {await work(transport.signal, current);}
        catch (cause) {if (current()) {if (denied(cause)) privacy(); publish({error: errorMessage(cause, 'Проверка OpenCode не подтверждена. Обновите состояние.')});}}
        finally {if (current()) {abort = undefined; publish({busy: false, reading: false});}}
    }
    async function history(signal: AbortSignal, current: () => boolean): Promise<CliJob[]> {
        const raw = await options.api.list(signal);
        if (!Array.isArray(raw)) throw Error('История проверок не подтверждена. Обновите состояние.');
        const jobs = raw.filter(item => record(item) && item.deviceId === options.deviceId && item.kind === kind)
            .map(item => readCliJob(item, options.deviceId,undefined,kind)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        if (current()) {
            historySnapshot=raw;
            initialized = true; publish({denied: false});
            if (!state.intent) {
                const latest = jobs[0], previous = state.job;
                if (latest) attemptedAutomatic = true;
                const older = latest && previous && previous.id !== latest.id && (Date.parse(previous.createdAt) > Date.parse(latest.createdAt)
                    || previous.createdAt === latest.createdAt && Date.parse(previous.updatedAt) > Date.parse(latest.updatedAt));
                publish({job: older ? previous : latest ? newerCliJob(previous, latest) : previous});
            }
        }
        return jobs;
    }
    async function recover(signal: AbortSignal, current: () => boolean): Promise<void> {
        const pending = state.intent; if (!pending) return;
        receiptConfirmed = false;
        publish({canReplay: false});
        try {
            const job = await readCliReceipt(await options.api.request(pending.request.requestKey, signal), pending);
            if (!current() || state.intent?.request.requestKey !== pending.request.requestKey) return;
            const accepted = {...pending, jobId: job.id};
            save(accepted);
            receiptConfirmed = true;
            publish({job: newerCliJob(state.job, job), canReplay: false, denied: false, error: ''});
        } catch (cause) {
            if (!current()) return;
            if (statusOf(cause) === 404) publish({canReplay: !pending.jobId && !state.storageError && !state.denied && pending.role === options.role,
                error: pending.jobId ? 'Ранее принятое задание недоступно. Исходный ключ сохранён; новую проверку не отправляем.' : 'Сервер пока не подтвердил отправку. Проверьте её снова или явно повторите тот же сохранённый запрос.'});
            else {if (denied(cause)) privacy(); throw cause;}
        }
    }
    async function dispatch(pending: CliIntent, signal: AbortSignal, current: () => boolean): Promise<void> {
        if (!current() || !options.canStart() || pending.role !== options.role || !save(pending)) return;
        publish({canReplay: false});
        try {
            const job = readCliJob(await options.api.create(pending.request, signal), options.deviceId, pending.jobId,kind);
            if (!current()) return;
            if (!save({...pending, jobId: job.id})) return;
        } catch (cause) {
            if (!current()) return;
            if (denied(cause)) {privacy(); publish({error: errorMessage(cause, 'Доступ к проверке отозван. Исходный запрос сохранён.')}); return;}
            publish({error: errorMessage(cause, 'Ответ на отправку потерян. Проверяем исходный ключ.')});
        }
        if (current()) await recover(signal, current);
    }
    async function start(automatic: boolean): Promise<void> {
        if(automatic&&kind===OPENCODE_CLI_INSTALL_JOB)return;
        if (!initialized || !options.canStart() || !options.lock || state.storageError || state.denied || automatic && (attemptedAutomatic || state.intent || state.job)) return;
        await run(async (signal, current) => {
            const jobs = await history(signal, current); if (!current() || !options.canStart()) return;
            const uncertain=jobs.find(job=>job.installation?.status==='unknown')??(state.job?.installation?.status==='unknown'?state.job:undefined);
            if(uncertain&&!installationReconciled(uncertain,historySnapshot)){publish({error:'Исход предыдущей установки требует сверки. Сначала проверьте OpenCode; новая установка не отправлена.'});return;}
            if (jobs.some(job => !cliTerminal(job))) {publish({error: 'На этом компьютере уже выполняется проверка. Обновите её состояние.'}); return;}
            let created = false;
            const pending = await options.lock!(key, () => {
                if (!current() || !options.canStart()) return undefined;
                const previous = state.intent;
                if (!loadJournal()) return undefined;
                const saved = state.intent;
                if (saved && (!previous || saved.request.requestKey !== previous.request.requestKey)) return saved;
                if (saved && (!receiptConfirmed || !state.job || state.job.id !== saved.jobId || !cliTerminal(state.job))) return saved;
                if (automatic && (saved || state.job || attemptedAutomatic)) return undefined;
                const input={deviceId:options.deviceId,kind,scope:'global',requestKey:createBridgeRequestKey(options.requestKey)};
                const request = kind===OPENCODE_CLI_INSTALL_JOB?normalizeOpenCodeInstallRequest(input):normalizeOpenCodeCliRequest(input);
                const intent: CliIntent = {version: 1, email: options.email.trim().toLowerCase(), role: options.role, request};
                if (!save(intent)) return undefined;
                created = true; attemptedAutomatic = true; publish({job: undefined}); return intent;
            });
            if (!current() || !pending) return;
            if (created) await dispatch(pending, signal, current);
            else await recover(signal, current);
        });
    }
    return {
        activate(): void {active = true; epoch++; state = initialCliObservation(); initialized = false; attemptedAutomatic = false; receiptConfirmed = false; observed = null;historySnapshot=[]; options.onChange(state);},
        dispose(): void {active = false; epoch++; abort?.abort();},
        refresh: () => run(async (signal, current) => {loadJournal(); await history(signal, current); if (current() && state.intent) await recover(signal, current);}),
        check: () => run(async (signal, current) => {if (state.intent) await recover(signal, current); else await history(signal, current);}),
        automatic: () => start(true),
        start: () => start(false),
        replay: () => run(async (signal, current) => {
            const pending = state.intent;
            if (!pending || !state.canReplay || pending.jobId || state.storageError || !options.canStart() || pending.role !== options.role) return;
            await dispatch(pending, signal, current);
        }),
        cancel: () => run(async (signal, current) => {
            const job = state.job;
            if (!job || cliTerminal(job) || !options.canCancel() || state.denied) return;
            await options.api.cancel(job.id, signal);
            if (!current()) return;
            if (state.intent) await recover(signal, current); else await history(signal, current);
        }),
        storageChanged(): void {
            if (!active || !options.captureOwner()()) return;
            epoch++; abort?.abort(); abort = undefined; attemptedAutomatic = true; receiptConfirmed = false;
            publish({busy: false, reading: false, job: undefined, canReplay: false, storageError: 'Отправка изменена в другой вкладке. Обновите состояние перед продолжением.'});
        },
    };
}
