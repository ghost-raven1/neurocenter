import { useEffect, useRef } from 'react';
import { cliTerminal, type ICliObservationState } from '../../features/ComputerSetup/model';

/** Подтверждённое состояние OpenCode считается актуальным не дольше этого срока. */
export const START_AUTO_CHECK_STALE_MS = 15 * 60_000;

/**
 * Сохранённая отправка, которую ещё нужно подтвердить или дождаться.
 * Подтверждённая (resolved) отправка — с jobId завершённого задания — не
 * мешает повторной проверке: контроллер в этом случае создаст новое задание,
 * а не подтвердит старую квитанцию.
 */
export function pendingStartIntent(state: ICliObservationState): boolean {
    const intent = state.intent;
    if (!intent) return false;
    return !(!!intent.jobId && state.job?.id === intent.jobId && cliTerminal(state.job));
}

/**
 * Нужна ли свежая проверка OpenCode. Подтверждённые результаты — установка и
 * отсутствие команды; всё остальное (ошибка, тайм-аут, установка без сверки)
 * требует повторного чтения. Незавершённая работа, неподтверждённая отправка
 * и явная отмена не повторяются.
 */
export function startAutoInspectNeeded(state: ICliObservationState, now = Date.now()): boolean {
    if (state.busy || state.reading || state.denied || state.storageError) return false;
    if (pendingStartIntent(state)) return false;
    const job = state.job;
    if (!job) return true;
    if (!cliTerminal(job)) return false;
    if (job.state === 'cancelled') return false;
    const confirmed = job.observation?.status === 'installed' || job.observation?.status === 'missing';
    const age = now - Date.parse(job.updatedAt);
    return !confirmed || !Number.isFinite(age) || age > START_AUTO_CHECK_STALE_MS;
}

interface IAutoInspectProps {
    enabled: boolean;
    flag: boolean;
    deviceId?: string;
    canStart: boolean;
    state: ICliObservationState;
    start(): void;
}

/**
 * Одна автоматическая свежая проверка на выбранный компьютер: ожидает, пока
 * загрузка журнала и сохранённая отправка разберутся (busy/reading/неподтверждённый
 * intent), и не повторяет попытку, если она уже сделана. Контроллер сам защищает
 * от дублей: незавершённое задание не дублируется, подтверждённая отправка
 * приводит к новому заданию, а не к повторному чтению той же квитанции.
 */
export function useStartAutoInspect({ enabled, flag, deviceId, canStart, state, start }: IAutoInspectProps): void {
    const tried = useRef('');
    useEffect(() => {
        if (!enabled || !flag || !deviceId) return;
        if (tried.current === deviceId) return;
        if (state.busy || state.reading || pendingStartIntent(state)) return;
        if (!canStart || state.denied || state.storageError) return;
        if (!startAutoInspectNeeded(state)) return;
        tried.current = deviceId;
        void start();
    }, [enabled, flag, deviceId, canStart, state, start]);
}
