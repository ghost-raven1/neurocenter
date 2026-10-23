import { isAxiosError } from 'axios';
import type { IBridgeJob, IBridgeJobInput, RuntimeCachePolicyPayload, RuntimeCachePolicyResult } from './api';
import { createBridgeRequestKey } from './bridgeRequestKey';
import { errorMessage } from '../../common/utils/errorMessage';

export const runtimeCacheMiB = 1024 ** 2;
type Request = Extract<IBridgeJobInput, {kind: 'runtime-cache-policy'}>;
interface Intent { request: Request; jobId?: string; draftMiB: number | null }
export interface RuntimeCacheSettingsState {
    draftMiB: number | null; dirty: boolean; status?: RuntimeCachePolicyResult;
    intent?: Intent; job?: IBridgeJob; busy: boolean; error: string;
}
interface Ports {
    deviceId: string; scope: string; captureOwner: () => () => boolean;
    create: (request: Request) => Promise<IBridgeJob>; jobs: () => Promise<IBridgeJob[]>;
    storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    inspectReason: () => string; setReason: () => string;
    onChange: (state: RuntimeCacheSettingsState) => void;
}
export const initialRuntimeCacheSettings = (): RuntimeCacheSettingsState => ({draftMiB: 2048, dirty: false, busy: false, error: ''});
const terminal = (job: IBridgeJob) => ['succeeded', 'failed', 'cancelled'].includes(job.state);
const validLimit = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1024 && value <= 16384;
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

/** A succeeded job must contain the complete numeric receipt before it becomes displayed policy. */
function receipt(value: unknown): RuntimeCachePolicyResult {
    if (!record(value) || !exact(value, ['schemaVersion', 'revision', 'limitBytes', 'usedBytes', 'defaultBytes', 'minBytes', 'maxBytes', 'observedAt'])
        || value.schemaVersion !== 1 || !natural(value.revision) || !natural(value.usedBytes) || !natural(value.limitBytes)
        || !validLimit(value.limitBytes / runtimeCacheMiB) || value.defaultBytes !== 2048 * runtimeCacheMiB
        || value.minBytes !== 1024 * runtimeCacheMiB || value.maxBytes !== 16384 * runtimeCacheMiB
        || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) || new Date(value.observedAt).toISOString() !== value.observedAt) {
        throw new Error('Мост не подтвердил настройки кэша. Обновите данные или проверьте сохранённый запрос.');
    }
    return value as unknown as RuntimeCachePolicyResult;
}

/** Keeps one exact owner/device intent through lost ACK and reload; recovery never generates a new mutation key. */
export function createRuntimeCacheSettings(ports: Ports) {
    const key = 'runtime-cache-policy:' + encodeURIComponent(JSON.stringify([ports.scope, ports.deviceId]));
    let state = initialRuntimeCacheSettings(), active = false, generation = 0, reading = false;
    const publish = (patch: Partial<RuntimeCacheSettingsState>) => { state = {...state, ...patch}; ports.onChange(state); };
    const readIntent = (): Intent | undefined => {
        try {
            const saved: unknown = JSON.parse(ports.storage.getItem(key) || 'null');
            if (!record(saved) || !record(saved.request)) return;
            const request = saved.request, payload = request.runtimeCachePolicy;
            if (!exact(request, ['deviceId', 'kind', 'runtimeCachePolicy', 'requestKey']) || request.deviceId !== ports.deviceId || request.kind !== 'runtime-cache-policy'
                || typeof request.requestKey !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(request.requestKey) || !record(payload)
                || payload.schemaVersion !== 1 || !(payload.action === 'inspect' && exact(payload, ['schemaVersion', 'action'])
                    || payload.action === 'set' && exact(payload, ['schemaVersion', 'action', 'expectedRevision', 'limitBytes'])
                        && natural(payload.expectedRevision) && payload.expectedRevision < Number.MAX_SAFE_INTEGER && natural(payload.limitBytes) && validLimit(payload.limitBytes / runtimeCacheMiB))
                || saved.jobId !== undefined && typeof saved.jobId !== 'string'
                || saved.draftMiB !== null && !(typeof saved.draftMiB === 'number' && Number.isFinite(saved.draftMiB))) return;
            return saved as unknown as Intent;
        } catch { return; }
    };
    const save = (intent: Intent | undefined) => {
        try {
            if (intent) {
                const bytes = JSON.stringify(intent);
                if (ports.storage.getItem(key) !== bytes) ports.storage.setItem(key, bytes);
                return ports.storage.getItem(key) === bytes;
            }
            if (readIntent()?.request.requestKey === state.intent?.request.requestKey) ports.storage.removeItem(key);
            return true;
        } catch { return false; }
    };
    const own = () => {
        const owns = ports.captureOwner(), captured = generation;
        return () => active && captured === generation && owns();
    };
    const adopt = (job: IBridgeJob, intent: Intent) => {
        if (job.deviceId !== ports.deviceId || job.projectId !== null || job.kind !== 'runtime-cache-policy' || !job.id || intent.jobId && job.id !== intent.jobId) {
            throw new Error('Ответ относится к другому заданию. Проверьте сохранённый запрос.');
        }
        const accepted = {...intent, jobId: job.id};
        save(accepted); publish({intent: accepted, job});
        if (!terminal(job)) return;
        if (job.state === 'succeeded') {
            const status = receipt(job.result);
            const command = intent.request.runtimeCachePolicy;
            if (command.action === 'set' && (status.limitBytes !== command.limitBytes || status.usedBytes > status.limitBytes
                || status.revision !== command.expectedRevision && status.revision !== command.expectedRevision + 1)) {
                throw new Error('Квитанция не подтверждает выбранный лимит. Проверьте сохранённый запрос.');
            }
            const replaceDraft = !state.dirty || intent.request.runtimeCachePolicy.action === 'set';
            save(undefined); publish({status, intent: undefined, error: '', ...(replaceDraft ? {draftMiB: status.limitBytes / runtimeCacheMiB, dirty: false} : {})});
        } else {
            save(undefined); publish({intent: undefined, error: job.message || 'Настройка кэша не применена. Обновите данные и повторите действие.'});
        }
    };
    async function refresh() {
        const current = own(), intent = state.intent;
        if (!current() || reading || !intent?.jobId) return;
        reading = true;
        try {
            const jobs = await ports.jobs(); if (!current()) return;
            const job = jobs.find(item => item.id === intent.jobId);
            if (!job) throw new Error('Принятое задание пока не найдено. Проверьте сохранённый запрос.');
            adopt(job, intent);
        } catch (cause) { if (current()) publish({error: errorMessage(cause, 'Не удалось обновить задание. Настройка может продолжаться на компьютере.')}); }
        finally { reading = false; }
    }
    async function send(intent: Intent, recovering: boolean) {
        const current = own(); if (!current() || state.busy) return;
        if (!save(intent)) {
            publish({error: 'Не удалось сохранить запрос в браузере. Разрешите хранилище сайта или освободите место и повторите. Запрос мосту не отправлен.'});
            return;
        }
        publish({intent, job: undefined, busy: true, error: ''});
        try { const job = await ports.create(intent.request); if (current()) adopt(job, intent); }
        catch (cause) {
            if (!current()) return;
            // A late 4xx cannot disprove an earlier accepted request whose ACK was lost.
            if (!recovering && isAxiosError(cause) && [400, 403, 409, 422].includes(cause.response?.status || 0)) {
                save(undefined); publish({intent: undefined});
            }
            publish({error: errorMessage(cause, 'Приём запроса не подтверждён. Проверьте сохранённый запрос с прежним ключом.')});
        } finally { if (current()) publish({busy: false}); }
    }
    async function start(action: 'inspect' | 'set') {
        const current = own(); if (!current() || state.busy || state.intent) return;
        const saved = readIntent();
        if (saved) { publish({intent: saved, draftMiB: saved.draftMiB, dirty: saved.request.runtimeCachePolicy.action === 'set', error: 'Сначала проверьте сохранённый запрос.'}); return; }
        const reason = action === 'set' ? ports.setReason() : ports.inspectReason();
        if (reason) { publish({error: reason}); return; }
        if (action === 'set' && (!state.status || !validLimit(state.draftMiB))) { publish({error: 'Обновите данные и введите целое число от 1024 до 16384 МиБ.'}); return; }
        try {
            const payload: RuntimeCachePolicyPayload = action === 'inspect' ? {schemaVersion: 1, action} : {
                schemaVersion: 1, action, expectedRevision: state.status!.revision, limitBytes: state.draftMiB! * runtimeCacheMiB,
            };
            await send({request: {deviceId: ports.deviceId, kind: 'runtime-cache-policy', runtimeCachePolicy: payload, requestKey: createBridgeRequestKey()}, draftMiB: state.draftMiB}, false);
        } catch (cause) { if (current()) publish({error: errorMessage(cause, 'Не удалось подготовить запрос к мосту.')}); }
    }
    return {
        activate() {
            active = true; generation++;
            const intent = readIntent();
            state = {...initialRuntimeCacheSettings(), ...(intent ? {intent, draftMiB: intent.draftMiB, dirty: intent.request.runtimeCachePolicy.action === 'set'} : {})};
            ports.onChange(state); if (intent?.jobId) void refresh();
        },
        dispose() {active = false; generation++;},
        inspect: () => start('inspect'), set: () => start('set'), refresh,
        recover: () => state.intent ? send(state.intent, true) : Promise.resolve(),
        edit(value: number | null) {if (own()() && !state.busy && !state.intent) publish({draftMiB: value, dirty: true, error: ''});},
    };
}
