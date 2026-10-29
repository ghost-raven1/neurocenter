import {cliTerminal, type CliObservationState} from './model';

/** A missing receipt never means a missing installation. */
export function cliObservationPresentation(state: CliObservationState) {
    const {job, intent} = state, observation = job?.observation;
    const running = !!job && !cliTerminal(job), unknown = !!intent && !job;
    const label = observation?.status === 'installed' ? `OpenCode ${observation.version}` : observation?.status === 'missing' ? 'OpenCode не найден'
        : observation?.status === 'timed-out' ? 'Проверка превысила срок' : observation?.status === 'failed' || job?.state === 'failed' ? 'Проверка не завершена'
            : job?.state === 'cancelled' ? 'Проверка отменена' : job?.state === 'queued' ? 'Проверка в очереди' : job?.state === 'reconciling' ? 'Подтверждаем результат…'
                : running ? 'Мост проверяет OpenCode…' : unknown ? state.reading ? 'Проверяем принятие отправки…' : 'Отправка пока не подтверждена' : 'Версия ещё не проверена';
    return {label, running, unknown, observation, notice: state.storageError || state.error};
}
