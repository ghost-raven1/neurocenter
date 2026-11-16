import { useCallback, useRef, useState } from 'react';
import { errorMessage } from '../../../common/utils/errorMessage';
import type { ICatalogModel } from '../interfaces';

/**
 * Единый адаптивный поток подключения модели (8.19 P1-1):
 * шаг 1 «Подключение» (общий адрес провайдера) → шаг 2 «Ключ» («Мой доступ», только когда
 * authMode требует ключ — OQ-8) → шаг 3 «Готовность» (операция подключения + автопроверка).
 * Все четыре точки входа (карточка / вкладка RAG / чекбокс локального индекса / подтверждение
 * reindex) прогоняют одну и ту же машину на существующих модалках.
 */
export type TConnectStep = 'connection' | 'access' | 'run';
export type TConnectPhase = TConnectStep | 'ready' | 'failed';
export type TConnectOrigin = 'reindex' | 'local';

export interface IConnectRunResult {
    ok: boolean;
    /** Выбор уже подтверждён для модели — шаг 3 завершается без ожидания автопроверки. */
    connected?: boolean;
    error?: string;
}

interface IDeps {
    /** Адаптивный первый шаг: подключение → ключ (при authMode) → прямое подключение. */
    plan: (model: ICatalogModel) => Promise<TConnectStep>;
    /** Операция подключения (шаг 3). Для origin 'local' операция запускается внешней формой. */
    run: (model: ICatalogModel) => Promise<IConnectRunResult>;
}

interface IState {
    model?: ICatalogModel;
    phase?: TConnectPhase;
    origin: TConnectOrigin;
}

export function useConnectSequence({ plan, run }: IDeps) {
    const deps = useRef({ plan, run });
    deps.current = { plan, run };
    const [model, setModelState] = useState<ICatalogModel>();
    const [phase, setPhaseState] = useState<TConnectPhase>();
    const [origin, setOriginState] = useState<TConnectOrigin>('reindex');
    const [error, setError] = useState('');
    /** Мутации фиксируются до рендера: быстрый результат операции не читает устаревшее состояние. */
    const stateRef = useRef<IState>({ origin: 'reindex' });
    const setModel = useCallback((target?: ICatalogModel) => {
        stateRef.current.model = target;
        setModelState(target);
    }, []);
    const setPhase = useCallback((next?: TConnectPhase) => {
        stateRef.current.phase = next;
        setPhaseState(next);
    }, []);
    const setOrigin = useCallback((next: TConnectOrigin) => {
        stateRef.current.origin = next;
        setOriginState(next);
    }, []);
    /** Новый пользовательский шаг отменяет ещё не завершённую операцию подключения. */
    const runTicket = useRef(0);
    const executeRun = useCallback(
        async (target: ICatalogModel, local: boolean) => {
            const ticket = ++runTicket.current;
            setModel(target);
            setPhase('run');
            setError('');
            if (local) return;
            let result: IConnectRunResult;
            try {
                result = await deps.current.run(target);
            } catch (cause) {
                result = { ok: false, error: errorMessage(cause, 'Не удалось подключить модель. Повторите попытку.') };
            }
            if (ticket !== runTicket.current || stateRef.current.model !== target) return;
            if (!result.ok) {
                setPhase('failed');
                setError(result.error ?? 'Не удалось подключить модель. Повторите попытку.');
                return;
            }
            if (result.connected) {
                setPhase('ready');
                setError('');
            }
        },
        [setModel, setPhase],
    );
    /** Точка входа: шаг либо задаёт plan, либо фиксируется конкретной точкой входа. */
    const begin = useCallback(
        async (target: ICatalogModel, step?: TConnectStep, local = false): Promise<TConnectStep> => {
            const first = step ?? (await deps.current.plan(target));
            setOrigin(local ? 'local' : 'reindex');
            if (first === 'run') void executeRun(target, local);
            else {
                setModel(target);
                setPhase(first);
                setError('');
            }
            return first;
        },
        [executeRun, setModel, setOrigin, setPhase],
    );
    /** Шаг завершён (модалка закрыта): «Мой доступ» → подключение, либо прямое подключение. */
    const advance = useCallback(
        (next: TConnectStep | 'done') => {
            const current = stateRef.current.model;
            if (!current) return;
            if (next === 'done') void executeRun(current, stateRef.current.origin === 'local');
            else {
                setPhase(next);
                setError('');
            }
        },
        [executeRun, setPhase],
    );
    /** Автопроверка (шаг 3): компонент наблюдает состояние и подтверждает результат. */
    const markReady = useCallback(() => {
        if (stateRef.current.phase === 'run') {
            setPhase('ready');
            setError('');
        }
    }, [setPhase]);
    const markFailed = useCallback(
        (message: string) => {
            if (stateRef.current.phase === 'run') {
                setPhase('failed');
                setError(message);
            }
        },
        [setPhase],
    );
    const retry = useCallback(() => {
        const current = stateRef.current.model;
        if (!current || stateRef.current.phase !== 'failed') return;
        void executeRun(current, stateRef.current.origin === 'local');
    }, [executeRun]);
    const close = useCallback(() => {
        runTicket.current++;
        setModel(undefined);
        setPhase(undefined);
        setError('');
    }, [setModel, setPhase]);
    /**
     * Закрытие модалки по текущему шагу: колбэк может держать старое рендер-состояние,
     * поэтому переход проверяется по актуальной фазе потока, а не по closure.
     */
    const settle = useCallback(
        (modelId: string, expected: TConnectPhase, next: TConnectStep | 'done' | 'closed') => {
            if (stateRef.current.phase !== expected || stateRef.current.model?.id !== modelId) return;
            if (next === 'closed') {
                runTicket.current++;
                setModel(undefined);
                setPhase(undefined);
                setError('');
            } else if (next === 'done') {
                void executeRun(stateRef.current.model, stateRef.current.origin === 'local');
            } else {
                setPhase(next);
                setError('');
            }
        },
        [executeRun, setModel, setPhase],
    );
    return {
        model,
        phase,
        error,
        origin,
        active: !!phase,
        begin,
        advance,
        markReady,
        markFailed,
        retry,
        close,
        settle,
    };
}
