import { roleLevel } from '../../../UserBlock/roles';
import { cliRequestFingerprint } from '../../../ComputerSetup/hooks/receipt';
import { createBridgeRequestKey } from '../../../McpBridge/bridgeRequestKey';
import { errorMessage } from '../../../../common/utils/errorMessage';
import {
    OPENCODE_PERSONAL_KEY_JOB,
    normalizeOpenCodePersonalKeyRequest,
    normalizeOpenCodePersonalKeyReceipt,
    normalizeOpenCodePersonalKeyResult,
} from '../contract';
import type { ITransferControllerOptions, ITransferIntent, ITransferState } from '../interfaces';
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const initial = (): ITransferState => ({
    intent: undefined,
    result: undefined,
    receipt: undefined,
    busy: false,
    error: '',
    journalError: '',
    canReplay: false,
    canRestart: false,
});

/** The durable public intent survives lost ACK; only the private native window can authorize a key write. */
export function createLocalKeyTransferController(options: ITransferControllerOptions) {
    const journalKey =
        'neurocenter:personal-key-transfer:v1:' + JSON.stringify([options.owner, options.deviceId, options.modelId]);
    let state = initial(),
        active = false,
        epoch = 0,
        flight: AbortController | undefined;
    const emit = (patch: Partial<ITransferState>) => {
        state = { ...state, ...patch };
        options.onChange(state);
    };
    const own = () => {
        const generation = epoch,
            auth = options.captureOwner();
        return () => active && epoch === generation && auth();
    };
    const read = (): ITransferIntent | undefined => {
        if (!options.storage) throw Error('Журнал браузера недоступен. Открытие окна приостановлено.');
        const raw = options.storage.getItem(journalKey);
        if (raw === null) return;
        const value: unknown = JSON.parse(raw);
        if (
            !object(value) ||
            Object.keys(value).some((key) => !['request', 'jobId', 'role'].includes(key)) ||
            typeof value.role !== 'string' ||
            roleLevel(value.role) < 2 ||
            (value.jobId !== undefined && !uuid(value.jobId))
        )
            throw Error('Журнал передачи повреждён. Прежний запрос сохранён.');
        const request = normalizeOpenCodePersonalKeyRequest(value.request);
        if (request.deviceId !== options.deviceId || request.modelId !== options.modelId)
            throw Error('Журнал относится к другому получателю.');
        return { role: value.role as string, request, ...(value.jobId ? { jobId: value.jobId as string } : {}) };
    };
    const sameTarget = (intent: ITransferIntent) => {
        const target = options.target();
        return (
            intent.request.providerId === target.providerId &&
            intent.request.expectedConnectionRevision === target.connectionRevision &&
            intent.request.expectedCredentialRevision === target.credentialRevision
        );
    };
    const persist = async (intent: ITransferIntent, previous: ITransferIntent | undefined, current: () => boolean) => {
        if (!options.storage || !options.lock) throw Error('Защищённый журнал недоступен. Новое окно не открыто.');
        await options.lock(journalKey, () => {
            if (!current()) return;
            const existing = read();
            if (JSON.stringify(existing) !== JSON.stringify(previous))
                throw Error('Журнал изменён в другой вкладке. Перечитайте прежнюю квитанцию.');
            options.storage!.setItem(journalKey, JSON.stringify(intent));
        });
        if (current()) emit({ intent });
    };
    const job = (raw: unknown, intent: ITransferIntent) => {
        if (
            !object(raw) ||
            !uuid(raw.id) ||
            raw.deviceId !== options.deviceId ||
            raw.projectId !== null ||
            raw.kind !== OPENCODE_PERSONAL_KEY_JOB ||
            (intent.jobId && raw.id !== intent.jobId)
        )
            throw Error('Сервер не подтвердил исходное окно передачи.');
        const result =
            object(raw.result) && Object.keys(raw.result).length
                ? normalizeOpenCodePersonalKeyResult(raw.result)
                : undefined;
        if (
            result &&
            (result.deviceId !== options.deviceId ||
                result.jobId !== raw.id ||
                result.kind !== OPENCODE_PERSONAL_KEY_JOB)
        )
            throw Error('Ответ относится к другому окну.');
        return { id: raw.id, result };
    };
    const lookup = async (signal: AbortSignal, current: () => boolean) => {
        const intent = state.intent;
        if (!intent) return;
        try {
            const found = await options.api.request(intent.request.requestKey, signal);
            if (!current()) return;
            if (
                found.requestKey !== intent.request.requestKey ||
                found.requestFingerprint !==
                    (await cliRequestFingerprint({ role: intent.role, request: intent.request }))
            )
                throw Error('Квитанция не подтверждает исходный запрос и роль.');
            if (!current()) return;
            const foundJob = job(found.job, intent),
                accepted = { ...intent, jobId: foundJob.id };
            if (!intent.jobId) {
                emit({ intent: accepted, canReplay: false });
                try {
                    await persist(accepted, intent, current);
                } catch (cause) {
                    emit({ journalError: 'UUID принятого окна не сохранён. Повтор открытия запрещён.' });
                    throw cause;
                }
            }
            if (!current()) return;
            emit({ result: foundJob.result, canReplay: false });
        } catch (cause) {
            if (!current()) return;
            if ((cause as { response?: { status?: number } })?.response?.status !== 404) throw cause;
            emit({
                canReplay: !intent.jobId,
                error: intent.jobId
                    ? 'Принятое окно пока не подтверждено. Повтор открытия запрещён; перечитайте квитанцию.'
                    : 'Исходный запрос не подтверждён. Можно повторить только тот же UUID.',
            });
        }
        const accepted = state.intent;
        if (!current() || !accepted?.jobId) return;
        const raw = await options.api.receipt(options.modelId, accepted.jobId, signal);
        if (!current()) return;
        if (
            !object(raw) ||
            !Object.prototype.hasOwnProperty.call(raw, 'receipt') ||
            typeof raw.canStartNew !== 'boolean'
        )
            throw Error('Сервер не подтвердил состояние передачи.');
        if (raw.receipt === null) {
            emit({ canRestart: raw.canStartNew });
            return;
        }
        const receipt = normalizeOpenCodePersonalKeyReceipt(raw.receipt),
            request = accepted.request;
        if (
            receipt.jobId !== accepted.jobId ||
            receipt.requestKey !== request.requestKey ||
            receipt.modelId !== request.modelId ||
            receipt.providerId !== request.providerId ||
            receipt.connectionRevision !== request.expectedConnectionRevision ||
            receipt.credentialRevision !== request.expectedCredentialRevision + 1
        )
            throw Error('Квитанция относится к другому получателю или версии настройки.');
        const notify = !state.receipt;
        emit({ receipt, error: '', canReplay: false, canRestart: raw.canStartNew });
        if (notify) options.onSaved();
    };
    const run = async (work: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
        if (flight || !active) return;
        const current = own();
        if (!current()) return;
        const request = new AbortController();
        flight = request;
        emit({ busy: true, error: '' });
        try {
            await work(request.signal, current);
        } catch (cause) {
            if (current())
                emit({ error: errorMessage(cause, 'Не удалось проверить передачу. Исходный запрос сохранён.') });
        } finally {
            if (flight === request) flight = undefined;
            if (current()) emit({ busy: false });
        }
    };
    const dispatch = async (signal: AbortSignal, current: () => boolean) => {
        const intent = state.intent;
        if (!intent || !options.canOpen() || intent.role !== options.role || !sameTarget(intent) || !current()) return;
        try {
            const opened = job(await options.api.open(intent.request, signal), intent);
            if (current()) {
                const accepted = { ...intent, jobId: opened.id };
                emit({ intent: accepted, canReplay: false });
                try {
                    await persist(accepted, intent, current);
                } catch (cause) {
                    emit({ journalError: 'UUID принятого окна не сохранён. Повтор открытия запрещён.' });
                    throw cause;
                }
            }
        } catch (cause) {
            if (current()) emit({ error: errorMessage(cause, 'Ответ открытия не получен. Проверяем прежний UUID.') });
        }
        if (current()) await lookup(signal, current);
    };
    return {
        get state() {
            return state;
        },
        journalKey,
        activate() {
            active = true;
            epoch++;
            state = initial();
            try {
                emit({ intent: read() });
            } catch (cause) {
                emit({ journalError: errorMessage(cause, 'Не удалось прочитать журнал передачи.') });
            }
        },
        dispose() {
            active = false;
            epoch++;
            flight?.abort();
            flight = undefined;
        },
        refresh: () =>
            run(async (signal, current) => {
                const stored = read();
                if (
                    state.intent &&
                    (!stored ||
                        JSON.stringify(stored.request) !== JSON.stringify(state.intent.request) ||
                        stored.role !== state.intent.role ||
                        (state.intent.jobId && stored.jobId !== state.intent.jobId))
                )
                    throw Error('Журнал изменён другой вкладкой. Прежнее окно оставлено для проверки.');
                emit({ intent: stored, journalError: '' });
                await lookup(signal, current);
            }),
        open: () =>
            run(async (signal, current) => {
                if (!options.canOpen() || state.journalError) return;
                if (state.intent) {
                    await lookup(signal, current);
                    return;
                }
                const target = options.target();
                const intent = {
                    role: options.role,
                    request: normalizeOpenCodePersonalKeyRequest({
                        kind: OPENCODE_PERSONAL_KEY_JOB,
                        scope: 'global',
                        deviceId: options.deviceId,
                        modelId: options.modelId,
                        providerId: target.providerId,
                        expectedConnectionRevision: target.connectionRevision,
                        expectedCredentialRevision: target.credentialRevision,
                        requestKey: createBridgeRequestKey(),
                    }),
                };
                await persist(intent, undefined, current);
                if (current()) await dispatch(signal, current);
            }),
        beginAgain: () =>
            run(async (_signal, current) => {
                if (!state.canRestart || !options.canOpen() || !options.storage || !options.lock) return;
                const previous = state.intent;
                await options.lock(journalKey, () => {
                    if (!current()) return;
                    if (JSON.stringify(read()) !== JSON.stringify(previous))
                        throw Error('Журнал изменён. Перечитайте квитанцию.');
                    options.storage!.removeItem(journalKey);
                });
                if (current()) emit(initial());
            }),
        replay: () =>
            run(async (signal, current) => {
                if (!state.journalError && state.canReplay && !state.intent?.jobId) await dispatch(signal, current);
            }),
    };
}
