import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { bridgeSourceApi, type IBridgeSource } from './bridgeSource';

/** Вход на шаг проверяет только опись версий; смена роли и закрытие отсекают поздний ответ. */
export function useBridgeSource() {
    const { scope, captureOwner } = useAuthRequestOwner();
    const [state, setState] = useState<{ scope: string; data?: IBridgeSource; loading: boolean; saving: boolean; error: string }>({ scope, loading: true, saving: false, error: '' });
    const request = useRef<AbortController>();
    const busy = useRef(false);
    const activeRead = useRef<'check' | 'get' | 'save'>();
    const queued = useRef({check: false, force: false, reload: false});
    const load = useCallback(async (check = false, force = false, retainedError = ''): Promise<void> => {
        const owns = captureOwner();
        if (!owns()) return;
        if (busy.current) {
            if (check && activeRead.current !== 'check') { queued.current.check = true; queued.current.force ||= force; }
            if (!check) queued.current.reload = true;
            return;
        }
        busy.current = true; activeRead.current = check ? 'check' : 'get';
        const controller = new AbortController(); request.current = controller;
        const current = () => owns() && !controller.signal.aborted && request.current === controller;
        let failure = retainedError;
        setState(previous => ({ ...previous, scope, loading: true, saving: false, error: retainedError }));
        try {
            const data = await bridgeSourceApi.get(controller.signal);
            if (!current()) return;
            setState({ scope, data, loading: check, saving: false, error: retainedError });
            if (check) {
                const checked = await bridgeSourceApi.check(data.revision, controller.signal, force);
                if (current()) setState({ scope, data: checked, loading: false, saving: false, error: '' });
            }
        } catch (cause) {
            if (!current()) return;
            const error = errorMessage(cause, 'Не удалось проверить версии моста. Повторите проверку.');
            failure = error;
            // GET после ошибки возвращает сохранённый снимок и ошибку источника; он не считается свежей проверкой.
            try {
                const data = await bridgeSourceApi.get(controller.signal);
                if (current()) setState({ scope, data, loading: false, saving: false, error });
            } catch { if (current()) setState(previous => ({ ...previous, scope, loading: false, saving: false, error })); }
        } finally {
            if (request.current === controller) {
                busy.current = false; request.current = undefined; activeRead.current = undefined;
                const next = queued.current; queued.current = {check: false, force: false, reload: false};
                // Импорт не отменяет проверку описи: после неё отдельно перечитываем готовую поставку.
                if (owns() && !controller.signal.aborted && (next.check || next.reload)) void load(next.check, next.force, next.check ? '' : failure);
            }
        }
    }, [scope, captureOwner]);
    useEffect(() => {
        busy.current = false; queued.current = {check: false, force: false, reload: false}; setState({ scope, loading: true, saving: false, error: '' });
        void load(true);
        return () => { request.current?.abort(); request.current = undefined; busy.current = false; activeRead.current = undefined; queued.current = {check: false, force: false, reload: false}; };
    }, [scope, load]);

    const data = state.scope === scope ? state.data : undefined;
    const save = async (url: string): Promise<boolean> => {
        const owns = captureOwner();
        if (!owns() || busy.current || !data) return false;
        busy.current = true; activeRead.current = 'save';
        const controller = new AbortController(); request.current = controller;
        const current = () => owns() && !controller.signal.aborted && request.current === controller;
        let failure = '';
        setState(previous => ({ ...previous, saving: true, error: '' }));
        try {
            const saved = await bridgeSourceApi.save(url, data.revision, controller.signal);
            if (current()) { setState({ scope, data: saved, loading: false, saving: false, error: '' }); return true; }
        } catch (cause) {
            if (!current()) return false;
            const error = errorMessage(cause, 'Не удалось сохранить источник. Проверьте текущее значение и повторите.');
            failure = error;
            try {
                const latest = await bridgeSourceApi.get(controller.signal);
                if (current()) setState({ scope, data: latest, loading: false, saving: false, error });
            } catch { if (current()) setState(previous => ({ ...previous, saving: false, error })); }
        } finally {
            if (request.current === controller) {
                busy.current = false; request.current = undefined; activeRead.current = undefined;
                const next = queued.current; queued.current = {check: false, force: false, reload: false};
                if (owns() && !controller.signal.aborted && (next.check || next.reload)) void load(next.check, next.force, next.check ? '' : failure);
            }
        }
        return false;
    };
    return { data, loading: state.scope !== scope || state.loading, saving: state.scope === scope && state.saving,
        error: state.scope === scope ? state.error : '', check: () => load(true, true), reload: () => load(), save };
}
