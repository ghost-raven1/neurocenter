import {isAxiosError} from 'axios';
import {errorMessage} from '../../common/utils/errorMessage';
import {initialModelRateState, rateDraft, rateInput, rateMatches} from './model';
import type {ModelRateDraft, ModelRateLimit, ModelRateLimitInput, ModelRateState} from './types';

interface Options {
    read: (signal: AbortSignal) => Promise<ModelRateLimit>;
    write: (input: ModelRateLimitInput, signal: AbortSignal) => Promise<ModelRateLimit>;
    captureOwner: () => () => boolean; onChange: (state: ModelRateState) => void;
}

/** A lost PUT acknowledgement is reconciled by GET; retries keep its exact revision and input. */
export function createModelRateController(options: Options) {
    let state = initialModelRateState(), active = false, epoch = 0, readGeneration = 0, detachedDraft = false;
    let readAbort: AbortController | undefined, writeAbort: AbortController | undefined;
    const publish = (patch: Partial<ModelRateState>) => {state = {...state, ...patch}; if (active) options.onChange(state);};
    const dirty = () => {
        if (!state.policy || state.baseRevision === undefined) return false;
        try {return !rateMatches(state.policy, rateInput(state.draft, state.baseRevision));} catch {return true;}
    };
    const adopt = (policy: ModelRateLimit, notice = '') => {detachedDraft = false; publish({policy, draft: rateDraft(policy), baseRevision: policy.revision, conflict: undefined, pending: undefined, error: '', notice});};
    const denied = (cause: unknown) => isAxiosError(cause) && [401, 403, 404].includes(cause.response?.status ?? 0);
    async function refresh(): Promise<void> {
        if (!active || state.saving) return;
        const owns = options.captureOwner(), ownerEpoch = epoch; if (!owns()) return;
        readAbort?.abort(); const abort = new AbortController(); readAbort = abort; const generation = ++readGeneration;
        const current = () => active && epoch === ownerEpoch && generation === readGeneration && owns() && !abort.signal.aborted;
        publish({loading: true, error: '', notice: ''});
        try {
            const policy = await options.read(abort.signal); if (!current()) return;
            if (state.pending) {
                if (rateMatches(policy, state.pending)) adopt(policy, 'Текущие настройки подтверждены.');
                else if (policy.revision !== state.pending.expectedRevision) publish({policy, conflict: policy, pending: undefined, error: 'Настройки уже изменены. Сравните их с вашим вводом.'});
                else publish({policy, error: 'Сохранение не подтверждено. Можно повторить тот же запрос или обновить сведения.'});
            } else if (detachedDraft) {
                detachedDraft = false; publish({policy, conflict: policy, error: 'Доступ восстановлен. Сравните текущие настройки с сохранённым вводом.'});
            } else if (dirty()) {
                const changed = policy.revision !== state.baseRevision;
                publish({policy, ...(changed ? {conflict: policy, error: 'Настройки уже изменены. Ваш ввод сохранён.'} : {})});
            } else adopt(policy);
        } catch (cause) {if (current()) {
            if (denied(cause)) detachedDraft ||= dirty() || !!state.pending;
            publish({...(denied(cause) ? {policy: undefined, conflict: undefined, pending: undefined, baseRevision: undefined} : {}), error: errorMessage(cause, 'Не удалось загрузить лимит. Повторите запрос.')});
        }}
        finally {if (current()) publish({loading: false});}
    }
    async function save(): Promise<void> {
        if (!active || state.saving || state.loading || state.conflict || !state.policy?.canManage || state.baseRevision === undefined) return;
        const owns = options.captureOwner(), ownerEpoch = epoch; if (!owns()) return;
        let input: ModelRateLimitInput;
        try {input = state.pending ?? rateInput(state.draft, state.baseRevision);} catch (cause) {publish({error: errorMessage(cause, 'Проверьте введённые значения.')}); return;}
        readGeneration++; readAbort?.abort(); writeAbort?.abort(); const abort = new AbortController(); writeAbort = abort;
        const current = () => active && epoch === ownerEpoch && owns() && !abort.signal.aborted;
        publish({saving: true, pending: input, error: '', notice: ''});
        try {
            const policy = await options.write(input, abort.signal); if (current()) adopt(policy, 'Лимит сохранён.');
        } catch (cause) {
            if (!current()) return;
            const status = isAxiosError(cause) ? cause.response?.status : undefined;
            if (denied(cause)) {detachedDraft = true; publish({policy: undefined, conflict: undefined, pending: undefined, baseRevision: undefined, error: errorMessage(cause, 'Нет доступа к настройкам лимита.')});}
            else if (status === 400 || status === 422) publish({pending: undefined, error: errorMessage(cause, 'Проверьте введённые значения.')});
            else {publish({saving: false, error: errorMessage(cause, 'Результат сохранения неизвестен. Проверяем текущие настройки.')}); await refresh();}
        } finally {if (current()) publish({saving: false});}
    }
    return {
        activate() {active = true; epoch++; detachedDraft = false; state = initialModelRateState(); options.onChange(state);},
        dispose() {active = false; epoch++; readGeneration++; readAbort?.abort(); writeAbort?.abort();},
        refresh, save,
        edit<K extends keyof ModelRateDraft>(key: K, value: ModelRateDraft[K]) {if (active && !state.saving && !state.pending) publish({draft: {...state.draft, [key]: value}, error: '', notice: ''});},
        useCurrent() {if (state.conflict) adopt(state.conflict, 'Загружены текущие настройки.');},
        keepDraft() {if (state.conflict) {detachedDraft = false; publish({policy: state.conflict, baseRevision: state.conflict.revision, conflict: undefined, pending: undefined, error: '', notice: 'Ваш ввод оставлен. Проверьте его и нажмите «Сохранить лимит».'});}},
    };
}
