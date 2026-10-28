import {isAxiosError} from 'axios';
import {errorMessage} from '../../common/utils/errorMessage';
import {checkedQuotaReceipt, checkedQuotaView, initialQuotaState, quotaDraft, quotaInput} from './model';
import {quotaStorageKey, readQuotaIntent, replaceQuotaJournal} from './storage';
import type {QuotaApi, QuotaDraft, QuotaIdentity, QuotaIntent, QuotaState, QuotaStorage, QuotaView} from './types';

interface Options extends QuotaIdentity {api: QuotaApi; storage?: QuotaStorage; captureOwner: () => () => boolean; onChange: (state: QuotaState) => void; onPrivacyDenied?: () => void; requestKey?: () => string;}
const status = (cause: unknown): number | undefined => isAxiosError(cause) ? cause.response?.status : undefined;
const privateDenied = (cause: unknown): boolean => [401, 403, 404].includes(status(cause) ?? 0);
const serverCode = (cause: unknown): unknown => isAxiosError(cause) ? (cause.response?.data as {code?: unknown} | undefined)?.code : undefined;

/** One exact intent survives reload/ACK loss; authoritative receipts, never a balance read, settle it. */
export function createQuotaController(options: Options) {
    const key = quotaStorageKey(options);
    let state = initialQuotaState(), active = false, epoch = 0, abort: AbortController | undefined;
    let observed: string | null = null, dirty = false;
    const publish = (patch: Partial<QuotaState>): void => {state = {...state, ...patch}; options.onChange(state);};
    const privacy = (cause: unknown): void => {
        publish({view: undefined, receipt: undefined, conflict: undefined, baseRevision: undefined, canReplay: false});
        if ([401, 403].includes(status(cause) ?? 0)) options.onPrivacyDenied?.();
    };
    function journal(value: QuotaIntent | undefined): boolean {
        try {observed = replaceQuotaJournal(options.storage, key, observed, value); publish({pending: value, storageError: ''}); return true;}
        catch (cause) {publish({storageError: errorMessage(cause, 'Не удалось сохранить устойчивый запрос. Отправка остановлена.')}); return false;}
    }
    function loadJournal(): void {
        try {
            if (!options.storage) throw Error('Хранилище браузера недоступно. Запись заблокирована; сведения можно читать.');
            const raw = options.storage.getItem(key), pending = readQuotaIntent(raw, options); observed = raw;
            publish({pending, storageError: '', canReplay: false, rejected: false, missing: false});
            if (pending) {dirty = true; publish({draft: quotaDraft(pending.input), baseRevision: pending.input.expectedRevision});}
        } catch (cause) {publish({storageError: errorMessage(cause, 'Не удалось прочитать сохранённый запрос.')});}
    }
    function adopt(view: QuotaView, keepDraft = false): void {
        const revision = view.policy?.revision ?? 0;
        if (!keepDraft) {
            dirty = false;
            publish({view, draft: view.policy ? quotaDraft(view.policy) : {...initialQuotaState().draft, ...quotaDraft({enabled: true, tokenLimit: 1, periodMs: view.defaults.periodMs}), tokenLimit: null}, baseRevision: revision, conflict: undefined});
        } else publish({view, conflict: state.baseRevision !== revision ? view : undefined});
    }
    async function run(action: (signal: AbortSignal, current: () => boolean) => Promise<void>): Promise<void> {
        const owns = options.captureOwner(); if (!active || !owns() || state.busy) return;
        const generation = epoch, transport = new AbortController(); abort = transport;
        const current = (): boolean => active && generation === epoch && owns();
        publish({busy: true, error: '', notice: ''});
        try {await action(transport.signal, current);}
        catch (cause) {if (current()) {if (privateDenied(cause)) privacy(cause); publish({error: errorMessage(cause, 'Не удалось прочитать квоту. Повторите проверку.')});}}
        finally {if (current()) {abort = undefined; publish({busy: false});}}
    }
    async function readView(signal: AbortSignal, current: () => boolean, minimumRevision = 0): Promise<void> {
        const value = checkedQuotaView(await options.api.read(signal), options);
        const floor = Math.max(minimumRevision, state.receipt?.policy.revision ?? 0);
        if ((value.policy?.revision ?? 0) < floor) throw Error('Новый бюджет ещё не отражён в чтении. Обновите сведения; сохранение уже подтверждено.');
        if (current()) adopt(value, dirty || !!state.pending);
    }
    async function accept(value: unknown, pending: QuotaIntent, signal: AbortSignal, current: () => boolean): Promise<void> {
        const receipt = await checkedQuotaReceipt(value, options, pending.input);
        if (!current()) return;
        // A changed/stale tab must not erase another window's recovery checkpoint.
        const cleared = journal(undefined);
        publish({receipt, view: undefined, draft: quotaDraft(receipt.policy), baseRevision: receipt.policy.revision, conflict: undefined, canReplay: false, rejected: false, missing: false, error: '', notice: cleared ? 'Квота сохранена и подтверждена.' : 'Сервер подтвердил квоту. Локальная запись не очищена; повторите чтение подтверждения.'});
        if (cleared) dirty = false;
        // A write receipt proves the policy, not a balance for its new limit or duration.
        // Failure of this GET must never be handled as another uncertain PUT.
        try {await readView(signal, current, receipt.policy.revision);}
        catch (cause) {if (current()) {if (privateDenied(cause)) privacy(cause); publish({error: 'Квота сохранена, но актуальный расход недоступен. Обновите сведения.'});}}
    }
    async function recover(signal: AbortSignal, current: () => boolean): Promise<void> {
        const pending = state.pending; if (!pending) return;
        try {await accept(await options.api.receipt(pending.input.requestKey, signal), pending, signal, current);}
        catch (cause) {
            if (!current()) return;
            if (status(cause) === 404) publish({missing: true, canReplay: !state.rejected, error: 'Подтверждение пока не найдено. Сохранённое тело и ключ оставлены; новый запрос не создаётся.'});
            else {if (privateDenied(cause)) privacy(cause); publish({canReplay: false, error: errorMessage(cause, 'Не удалось проверить подтверждение. Сохранённый запрос оставлен.')});}
        }
    }
    async function dispatch(pending: QuotaIntent, signal: AbortSignal, current: () => boolean): Promise<void> {
        // Check the observed journal again immediately before transport; server key/CAS is final authority.
        if (!journal(pending) || !current()) return;
        try {await accept(await options.api.write(pending.input, signal), pending, signal, current);}
        catch (cause) {
            if (!current()) return;
            if (privateDenied(cause)) {privacy(cause); publish({error: errorMessage(cause, 'Нет доступа к настройке квоты. Запрос сохранён для восстановления.')}); return;}
            const message = errorMessage(cause, 'Ответ на сохранение потерян. Проверяем устойчивое подтверждение.');
            const rejected = [400, 422].includes(status(cause) ?? 0) || status(cause) === 409 && ['MODEL_TOKEN_QUOTA_REVISION_CONFLICT', 'MODEL_TOKEN_QUOTA_REQUEST_CONFLICT', 'MODEL_TOKEN_QUOTA_UNSUPPORTED_SURFACE'].includes(String(serverCode(cause)));
            publish({error: message, rejected, canReplay: false, missing: false});
            await recover(signal, current);
            if (current() && rejected) await readView(signal, current);
        }
    }
    return {
        activate(): void {active = true; epoch++; state = initialQuotaState(); dirty = false; options.onChange(state); loadJournal();},
        dispose(): void {active = false; epoch++; abort?.abort();},
        initialize: () => run(async (signal, current) => {await readView(signal, current); if (current()) await recover(signal, current);}),
        refresh: () => run(readView),
        recover: () => run(recover),
        reloadJournal: () => run(async (signal, current) => {loadJournal(); if (current()) {await readView(signal, current); if (current()) await recover(signal, current);}}),
        save: () => run(async (signal, current) => {
            if (!state.view?.canManage || state.pending || state.storageError || state.conflict || state.baseRevision === undefined) return;
            const input = quotaInput(state.draft, state.baseRevision, options.requestKey?.() ?? crypto.randomUUID());
            await dispatch({schemaVersion: 1, scope: options.scope, writerEmail: options.writerEmail, modelId: options.modelId, userEmail: options.userEmail, input}, signal, current);
        }),
        replay: () => run(async (signal, current) => {
            if (!state.view?.canManage || !state.pending || !state.canReplay || state.storageError) return;
            await dispatch(state.pending, signal, current);
        }),
        edit<K extends keyof QuotaDraft>(field: K, value: QuotaDraft[K]): void {
            if (!active || !options.captureOwner()() || state.busy || state.pending) return;
            dirty = true; publish({draft: {...state.draft, [field]: value}, error: '', notice: ''});
        },
        resolveConflict(keepDraft: boolean): void {
            if (!active || !options.captureOwner()() || state.busy || !state.view?.canManage || !(state.conflict || state.pending && state.rejected && state.missing) || state.pending && !(state.rejected && state.missing)) return;
            if (state.pending && !journal(undefined)) return;
            const view = state.conflict ?? state.view, draft = state.draft; adopt(view, false);
            if (keepDraft) {dirty = true; publish({draft});}
            publish({rejected: false, missing: false, canReplay: false, notice: keepDraft ? 'Проверьте свой ввод и сохраните отдельным новым запросом.' : 'Загружены текущие настройки.'});
        },
        storageChanged(): void {if (active) publish({storageError: 'Сохранённый запрос изменён в другой вкладке. Проверьте его перед продолжением.', canReplay: false});},
    };
}
